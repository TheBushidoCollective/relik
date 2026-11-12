/**
 * What relic-mcp admits to a wrap, when the service answers about the owner's
 * roster (PS-05, PS2-04, PS2-05). Each test drives the real publish or show path
 * against the fake service, which answers what the test set. A revocation or a
 * designation counts only when the owner signed it, and what the service asserts
 * alone never moves the floor this machine keeps.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  identityFingerprint,
  signStatement,
  type StatementKind,
  statementBytes,
} from '@relic/format/private';
import { publishPrivate, showPrivateRelic } from '../src/private.ts';
import type { PublishDeps } from '../src/publish.ts';
import {
  DAY_MS,
  deviceRecord,
  FakeService,
  makeCert,
  makeDevice,
  makePerson,
  ORIGIN,
  type Person,
  partyJson,
  pinDevice,
  publishFixture,
  signer,
  type TestDevice,
} from './private-fixtures.ts';

const SOURCE = new TextEncoder().encode('# Roster\n\nThe floor holds.\n');
const SOURCE_PATH = '/work/roster.md';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-roster-freshness-'));
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'device-keys.json');
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'publish-state.json');
});

afterEach(async () => {
  delete process.env['RELIC_DEVICE_KEYS'];
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(dir, { recursive: true, force: true });
});

/** One machine with one published private relic, and the fake service it asks. */
interface Machine {
  readonly owner: Person;
  readonly device: TestDevice;
  readonly service: FakeService;
  readonly deps: PublishDeps;
  readonly relicId: string;
}

async function machine(): Promise<Machine> {
  const owner = await makePerson('owner@example.com');
  const device = await makeDevice('relic-mcp on the test machine');
  await pinDevice(ORIGIN, owner, device);
  const service = new FakeService({ owner, device });
  const fixture = publishFixture(service, SOURCE, SOURCE_PATH);
  const published = await publishPrivate({ path: SOURCE_PATH }, fixture.deps);
  return {
    owner,
    device,
    service,
    deps: fixture.deps,
    relicId: published.relic_id,
  };
}

interface Signed {
  readonly statement: Record<string, unknown>;
  readonly identity_signature: string;
}

async function signedBy(
  person: Person,
  kind: StatementKind,
  statement: Record<string, unknown>
): Promise<Signed> {
  const identity_signature = await signStatement(
    signer(person.keys.sig.privateKey),
    statementBytes(kind, statement as never)
  );
  return { statement, identity_signature };
}

/** The recipients answer for the owner, with the caller's own device and whatever the test adds. */
async function recipientsBody(
  owner: Person,
  device: TestDevice,
  over: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const notAfter = Date.now() + 365 * DAY_MS;
  const own = await makeCert({ owner, device, notAfter });
  return {
    access_epoch: 0,
    owner_epoch: 0,
    current_version: 1,
    sealed_version: 1,
    owner: partyJson(owner),
    devices: [deviceRecord(owner.identityId, device, own, notAfter)],
    grants: [],
    recovery: null,
    recovery_statement: null,
    ...over,
  };
}

/** The owner-signed revocation of one grant, signed by `by` (the owner unless a test forges it). */
function revocationOf(
  by: Person,
  owner: Person,
  grantee: Person,
  relicId: string,
  at: number
): Promise<Signed> {
  return signedBy(by, 'revocation', {
    at,
    grantee_identity_id: grantee.identityId,
    owner_identity_id: owner.identityId,
    relic_id: relicId,
  });
}

/** A grant entry as `/recipients` carries it: the owner's grant, and whatever revocation fields the test sets. */
async function grantEntry(
  owner: Person,
  grantee: Person,
  relicId: string,
  at: number,
  over: { revoked_at?: string | null; revocation?: unknown } = {}
): Promise<Record<string, unknown>> {
  const signed = await signedBy(owner, 'grant', {
    at,
    fingerprint_typed: await identityFingerprint(
      grantee.identityId,
      grantee.email
    ),
    grantee_email: grantee.email,
    grantee_identity_id: grantee.identityId,
    owner_identity_id: owner.identityId,
    relic_id: relicId,
    versions: [1],
  });
  return {
    statement: signed.statement,
    identity_signature: signed.identity_signature,
    granted_at: new Date(at).toISOString(),
    revoked_at: null,
    revocation: null,
    grantee: partyJson(grantee),
    ...over,
  };
}

/** A recovery holder as `recovery` carries it: the holder, and the owner's signed designation of it. */
async function holderEntry(
  owner: Person,
  holder: Person,
  at: number
): Promise<Record<string, unknown>> {
  const designation = await signedBy(owner, 'recovery_designation', {
    at,
    fingerprint_typed: await identityFingerprint(
      holder.identityId,
      holder.email
    ),
    owner_identity_id: owner.identityId,
    recovery_email: holder.email,
    recovery_identity_id: holder.identityId,
  });
  return {
    ...partyJson(holder),
    designated_at: new Date(at).toISOString(),
    designation,
  };
}

/** The owner-signed removal of the holder, as `recovery_statement` carries it. */
function removalOf(owner: Person, at: number): Promise<Signed> {
  return signedBy(owner, 'recovery_designation', {
    at,
    fingerprint_typed: null,
    owner_identity_id: owner.identityId,
    recovery_email: null,
    recovery_identity_id: null,
  });
}

async function kindsOf(m: Machine): Promise<string[]> {
  const shown = await showPrivateRelic(m.deps, m.relicId);
  return shown.recipients.map((recipient) => recipient.kind);
}

describe('a grant the owner revoked stays out (PS2-04)', () => {
  test('a grant the owner revoked stays out when the service lists it live again', async () => {
    const m = await machine();
    const grantee = await makePerson('reader@example.com');
    const at = Date.now() - 60_000;
    const revokedAt = Date.now() - 1_000;
    m.service.recipients = await recipientsBody(m.owner, m.device, {
      grants: [
        await grantEntry(m.owner, grantee, m.relicId, at, {
          revoked_at: new Date(revokedAt).toISOString(),
          revocation: await revocationOf(
            m.owner,
            m.owner,
            grantee,
            m.relicId,
            revokedAt
          ),
        }),
      ],
    });
    expect(await kindsOf(m)).toEqual(['owner', 'device']);

    m.service.recipients = await recipientsBody(m.owner, m.device, {
      grants: [await grantEntry(m.owner, grantee, m.relicId, at)],
    });
    expect(await kindsOf(m)).toEqual(['owner', 'device']);
  });
});

describe('recovery designations never go backwards (PS-05)', () => {
  test('an older designation than the one accepted is refused', async () => {
    const m = await machine();
    const holder = await makePerson('holder@example.com');
    const newer = Date.now() - 1_000;
    m.service.recipients = await recipientsBody(m.owner, m.device, {
      recovery: await holderEntry(m.owner, holder, newer),
    });
    expect(await kindsOf(m)).toEqual(['owner', 'device', 'recovery']);

    m.service.recipients = await recipientsBody(m.owner, m.device, {
      recovery: await holderEntry(m.owner, holder, newer - 60_000),
    });
    await expect(showPrivateRelic(m.deps, m.relicId)).rejects.toMatchObject({
      code: 'recipients_stale',
    });
  });

  test('a holder the owner removed is no recipient, and a later answer that names it again is refused', async () => {
    const m = await machine();
    const holder = await makePerson('holder@example.com');
    const designated = Date.now() - 60_000;
    const removed = Date.now() - 1_000;
    // The service still names the old holder, but the owner's newest signed
    // designation is the removal, and it carries the greatest `at`.
    m.service.recipients = await recipientsBody(m.owner, m.device, {
      recovery: await holderEntry(m.owner, holder, designated),
      recovery_statement: await removalOf(m.owner, removed),
    });
    expect(await kindsOf(m)).toEqual(['owner', 'device']);

    m.service.recipients = await recipientsBody(m.owner, m.device, {
      recovery: await holderEntry(m.owner, holder, designated),
      recovery_statement: null,
    });
    await expect(showPrivateRelic(m.deps, m.relicId)).rejects.toMatchObject({
      code: 'recipients_stale',
    });
  });
});

describe('what the service asserts alone never moves the floor (PS2-05)', () => {
  test('a huge owner epoch and a false revoked flag do not stop a later publish', async () => {
    const m = await machine();
    m.service.contextEdit = (context) => ({
      ...context,
      owner_epoch: Number.MAX_SAFE_INTEGER,
      devices: (context['devices'] as Record<string, unknown>[]).map(
        (device) => ({ ...device, revoked_at: new Date().toISOString() })
      ),
    });
    const lying = await publishPrivate(
      { path: SOURCE_PATH, force_new: true },
      m.deps
    );
    expect(lying.access).toBe('private');

    m.service.contextEdit = undefined;
    const honest = await publishPrivate(
      { path: SOURCE_PATH, force_new: true },
      m.deps
    );
    expect(honest.access).toBe('private');
  });

  test('a live grant the service flags revoked without a signed revocation stays a recipient', async () => {
    const m = await machine();
    const grantee = await makePerson('reader@example.com');
    m.service.recipients = await recipientsBody(m.owner, m.device, {
      grants: [
        await grantEntry(m.owner, grantee, m.relicId, Date.now() - 60_000, {
          revoked_at: new Date().toISOString(),
          revocation: null,
        }),
      ],
    });
    expect(await kindsOf(m)).toEqual(['owner', 'device', 'grantee']);
  });

  test('a revoked entry whose revocation does not verify is ignored and does not abort the answer', async () => {
    const m = await machine();
    const grantee = await makePerson('reader@example.com');
    const attacker = await makePerson('attacker@example.com');
    const forged = await revocationOf(
      attacker,
      m.owner,
      grantee,
      m.relicId,
      Date.now() - 1_000
    );
    const notAfter = Date.now() + 365 * DAY_MS;
    const otherDevice = await makeDevice('a device with a forged certificate');
    const forgedCert = await makeCert({
      owner: m.owner,
      device: otherDevice,
      notAfter,
      signedBy: attacker,
    });
    const own = await makeCert({ owner: m.owner, device: m.device, notAfter });
    m.service.recipients = await recipientsBody(m.owner, m.device, {
      grants: [
        await grantEntry(m.owner, grantee, m.relicId, Date.now() - 60_000, {
          revoked_at: new Date().toISOString(),
          revocation: forged,
        }),
      ],
      devices: [
        deviceRecord(m.owner.identityId, m.device, own, notAfter),
        {
          ...deviceRecord(
            m.owner.identityId,
            otherDevice,
            forgedCert,
            notAfter
          ),
          revoked_at: new Date().toISOString(),
        },
      ],
    });
    expect(await kindsOf(m)).toEqual(['owner', 'device', 'grantee']);
  });
});
