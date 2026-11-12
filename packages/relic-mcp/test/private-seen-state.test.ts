/**
 * What the service has shown this machine about its pinned owner never goes
 * backwards (plan 4.12, PS-05). These tests drive `observeOwnerState` on a
 * real key file. It is the call the publish and read paths make after a
 * verified answer and before any key is wrapped to it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  grantKey,
  loadDeviceEntry,
  type OwnerObservation,
  observeOwnerState,
} from '../src/device.ts';
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

function observed(over: Partial<OwnerObservation> = {}): OwnerObservation {
  return { ownerEpoch: 1, devices: {}, ...over };
}

describe('what the service has shown this machine never goes backwards (PS-05)', () => {
  test('an owner epoch below the one already seen is refused, and nothing is recorded', async () => {
    await observeOwnerState(ORIGIN, observed({ ownerEpoch: 3 }));
    const seen = (await loadDeviceEntry(ORIGIN))?.owner_seen;
    await expect(
      observeOwnerState(ORIGIN, observed({ ownerEpoch: 2 }))
    ).rejects.toMatchObject({ code: 'recipients_stale' });
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen).toEqual(seen);
  });

  test('an equal owner epoch is accepted, so a second read of the same state works', async () => {
    await observeOwnerState(ORIGIN, observed({ ownerEpoch: 3 }));
    await observeOwnerState(ORIGIN, observed({ ownerEpoch: 3 }));
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen?.owner_epoch).toBe(3);
  });

  test('a recovery designation older than the one seen is refused, and a newer one replaces it', async () => {
    await observeOwnerState(ORIGIN, observed({ designatedAt: 500 }));
    await expect(
      observeOwnerState(ORIGIN, observed({ designatedAt: 400 }))
    ).rejects.toMatchObject({ code: 'recipients_stale' });
    await observeOwnerState(ORIGIN, observed({ designatedAt: 600 }));
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen?.designated_at).toBe(
      600
    );
  });

  test('a grant seen revoked is refused when the service reports the same grant active', async () => {
    const key = grantKey(RELIC_ID, 'grantee-identity');
    await observeOwnerState(
      ORIGIN,
      observed({ grants: { [key]: { at: 100, revoked: true } } })
    );
    await expect(
      observeOwnerState(
        ORIGIN,
        observed({ grants: { [key]: { at: 100, revoked: false } } })
      )
    ).rejects.toMatchObject({ code: 'recipients_stale' });
  });

  test('a grant issued again after its revocation is accepted, because its statement is newer', async () => {
    const key = grantKey(RELIC_ID, 'grantee-identity');
    await observeOwnerState(
      ORIGIN,
      observed({ grants: { [key]: { at: 100, revoked: true } } })
    );
    await observeOwnerState(
      ORIGIN,
      observed({ grants: { [key]: { at: 200, revoked: false } } })
    );
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen?.grants?.[key]).toEqual({
      at: 200,
      revoked: false,
    });
  });

  test('a grant reported with an older statement than the one seen is refused', async () => {
    const key = grantKey(RELIC_ID, 'grantee-identity');
    await observeOwnerState(
      ORIGIN,
      observed({ grants: { [key]: { at: 200, revoked: false } } })
    );
    await expect(
      observeOwnerState(
        ORIGIN,
        observed({ grants: { [key]: { at: 100, revoked: false } } })
      )
    ).rejects.toMatchObject({ code: 'recipients_stale' });
  });

  test('a device seen revoked is refused when reported active at the same certificate time', async () => {
    await observeOwnerState(
      ORIGIN,
      observed({ devices: { 'device-one': { at: 100, revoked: true } } })
    );
    await expect(
      observeOwnerState(
        ORIGIN,
        observed({ devices: { 'device-one': { at: 100, revoked: false } } })
      )
    ).rejects.toMatchObject({ code: 'recipients_stale' });
  });

  test('a device the service stops listing keeps its seen revocation', async () => {
    await observeOwnerState(
      ORIGIN,
      observed({ devices: { 'device-one': { at: 100, revoked: true } } })
    );
    await observeOwnerState(ORIGIN, observed({ devices: {} }));
    expect(
      (await loadDeviceEntry(ORIGIN))?.owner_seen?.devices?.['device-one']
    ).toEqual({ at: 100, revoked: true });
  });

  test('a first contact has nothing to hold the service to, so the answer is accepted', async () => {
    await expect(
      observeOwnerState(
        ORIGIN,
        observed({
          ownerEpoch: 7,
          designatedAt: 900,
          devices: { 'device-one': { at: 100, revoked: false } },
        })
      )
    ).resolves.toBeUndefined();
    expect((await loadDeviceEntry(ORIGIN))?.owner_seen?.owner_epoch).toBe(7);
  });
});
