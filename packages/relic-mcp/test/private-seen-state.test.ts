/**
 * What this machine has accepted about its pinned owner never goes backwards,
 * and only owner-signed facts move it (PS-05, PS2-04, PS2-05). These tests drive
 * `observeOwnerState` on a real key file: the call the publish and read paths
 * make after a verified answer and before any key is wrapped to it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RosterObservation } from '@relic/format/private';
import { grantKey, loadDeviceEntry, observeOwnerState } from '../src/device.ts';
import {
  makeDevice,
  makePerson,
  ORIGIN,
  type Person,
  pinDevice,
} from './private-fixtures.ts';

const RELIC_ID = '0123456789abcdefghjkmnpqrs';
let dir: string;
let owner: Person;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-seen-state-'));
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'device-keys.json');
  owner = await makePerson('owner@example.com');
  await pinDevice(ORIGIN, owner, await makeDevice('relic-mcp'));
});

afterEach(async () => {
  delete process.env['RELIC_DEVICE_KEYS'];
  await rm(dir, { recursive: true, force: true });
});

describe('what the service has shown this machine never goes backwards (PS-05)', () => {
  test('a recovery designation older than the one accepted is refused, and a newer one replaces it', async () => {
    await observeOwnerState(ORIGIN, {
      designation: { at: 500, removed: false },
    });
    await expect(
      observeOwnerState(ORIGIN, { designation: { at: 400, removed: false } })
    ).rejects.toMatchObject({ code: 'recipients_stale' });
    await observeOwnerState(ORIGIN, {
      designation: { at: 600, removed: false },
    });
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen?.designation).toEqual({
      at: 600,
      removed: false,
    });
  });

  test('an answer with no signed designation is refused once a designation was accepted', async () => {
    await observeOwnerState(ORIGIN, {
      designation: { at: 500, removed: false },
    });
    await expect(
      observeOwnerState(ORIGIN, { designation: null })
    ).rejects.toMatchObject({ code: 'recipients_stale' });
  });

  test('an accepted removal stays accepted, and a holder designated before it is refused', async () => {
    await observeOwnerState(ORIGIN, {
      designation: { at: 700, removed: true },
    });
    await expect(
      observeOwnerState(ORIGIN, { designation: { at: 650, removed: false } })
    ).rejects.toMatchObject({ code: 'recipients_stale' });
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen?.designation).toEqual({
      at: 700,
      removed: true,
    });
  });

  test('an owner epoch is not pinned, so no service answer about it can refuse a later one', async () => {
    // The observation carries no epoch: a count the service asserts alone is a
    // hint for the seal, not a fact this machine holds to.
    await observeOwnerState(ORIGIN, {});
    await observeOwnerState(ORIGIN, {});
    expect(
      (await loadDeviceEntry(ORIGIN))?.owner_seen ?? {}
    ).not.toHaveProperty('owner_epoch');
  });
});

describe('grants and devices stay revoked once the owner signed a revocation (PS2-04)', () => {
  const key = grantKey(RELIC_ID, 'grantee-identity');

  test('a grant seen revoked stays revoked when the service lists the same statement live', async () => {
    await observeOwnerState(ORIGIN, {
      grants: { [key]: { at: 100, revoked: true } },
    });
    const floor = await observeOwnerState(ORIGIN, {
      grants: { [key]: { at: 100, revoked: false } },
    });
    expect(floor.grants?.[key]).toEqual({ at: 100, revoked: true });
  });

  test('a grant issued again after its revocation is accepted, because its statement is newer', async () => {
    await observeOwnerState(ORIGIN, {
      grants: { [key]: { at: 100, revoked: true } },
    });
    const floor = await observeOwnerState(ORIGIN, {
      grants: { [key]: { at: 200, revoked: false } },
    });
    expect(floor.grants?.[key]).toEqual({ at: 200, revoked: false });
  });

  test('a grant reported with an older live statement than the one seen is refused', async () => {
    await observeOwnerState(ORIGIN, {
      grants: { [key]: { at: 200, revoked: false } },
    });
    await expect(
      observeOwnerState(ORIGIN, {
        grants: { [key]: { at: 100, revoked: false } },
      })
    ).rejects.toMatchObject({ code: 'recipients_stale' });
  });

  test('a device seen revoked stays revoked when a live certificate at the same time comes back', async () => {
    await observeOwnerState(ORIGIN, {
      devices: { 'device-1': { at: 300, revoked: true } },
    });
    const floor = await observeOwnerState(ORIGIN, {
      devices: { 'device-1': { at: 300, revoked: false } },
    });
    expect(floor.devices?.['device-1']).toEqual({ at: 300, revoked: true });
  });

  test('a device the service stops listing keeps its seen revocation', async () => {
    await observeOwnerState(ORIGIN, {
      devices: { 'device-1': { at: 300, revoked: true } },
    });
    const floor = await observeOwnerState(ORIGIN, { devices: {} });
    expect(floor.devices?.['device-1']).toEqual({ at: 300, revoked: true });
  });

  test('a revocation older than a live statement already accepted is refused, and nothing is recorded', async () => {
    await observeOwnerState(ORIGIN, {
      devices: { 'device-1': { at: 500, revoked: false } },
    });
    const before = (await loadDeviceEntry(ORIGIN))?.owner_seen;
    const refused: RosterObservation = {
      devices: { 'device-1': { at: 400, revoked: true } },
    };
    await expect(observeOwnerState(ORIGIN, refused)).rejects.toMatchObject({
      code: 'recipients_stale',
    });
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen).toEqual(before);
  });

  test('a first contact has nothing to hold the service to, so the answer is accepted', async () => {
    const floor = await observeOwnerState(ORIGIN, {
      designation: null,
      devices: {},
      grants: {},
    });
    expect(floor.designation).toBeUndefined();
  });
});
