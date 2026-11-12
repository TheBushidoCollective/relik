import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishPrivate } from '../src/private.ts';
import { loadPrivatePublishState } from '../src/state.ts';
import {
  FakeService,
  makeDevice,
  makePerson,
  ORIGIN,
  pinDevice,
  publishFixture,
  RELIC_ORIGIN,
} from './private-fixtures.ts';

const SOURCE = new TextEncoder().encode(
  '# Quarterly review\n\nThe plan holds.\n'
);
const SOURCE_PATH = '/work/report.md';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-private-publish-'));
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'device-keys.json');
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'publish-state.json');
});

afterEach(async () => {
  delete process.env['RELIC_DEVICE_KEYS'];
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(dir, { recursive: true, force: true });
});

/** A machine with a confirmed device for one owner, and a fake service that trusts it. */
async function confirmedMachine(options: { capability?: boolean } = {}) {
  const owner = await makePerson('owner@example.com');
  const device = await makeDevice('relic-mcp on the test machine');
  await pinDevice(ORIGIN, owner, device);
  const service = new FakeService({
    owner,
    device,
    ...(options.capability === undefined
      ? {}
      : { capability: options.capability }),
  });
  return {
    owner,
    device,
    service,
    fixture: publishFixture(service, SOURCE, SOURCE_PATH),
  };
}

describe('private publish', () => {
  test('publishes with no passkey, returns a keyless link, and leaks no key', async () => {
    const { service, fixture } = await confirmedMachine();
    const result = await publishPrivate({ path: SOURCE_PATH }, fixture.deps);

    expect(result.access).toBe('private');
    expect(result.url).toBe(`${RELIC_ORIGIN}/${result.relic_id}`);
    expect(result.url.includes('#')).toBe(false);
    expect(result.relic_expires_at).not.toBeNull();

    const state = await loadPrivatePublishState(result.relic_id);
    const key = state?.version_keys['1'];
    expect(key).toBeDefined();
    // The key is what this machine holds. It must appear in none of the
    // output, and in none of the bodies this machine sent.
    const everythingSent = [
      JSON.stringify(result),
      ...service.requests.map((request) => request.body),
    ].join('\n');
    expect(everythingSent.includes(key ?? 'no key')).toBe(false);
  });

  test('wraps to the owner and to the certified device, and seals as the device', async () => {
    const { service, fixture } = await confirmedMachine();
    const result = await publishPrivate({ path: SOURCE_PATH }, fixture.deps);

    expect(result.recipients.map((recipient) => recipient.kind)).toEqual([
      'owner',
      'device',
    ]);
    expect(service.grants).toHaveLength(1);
    expect(service.grants[0]?.['access']).toBe('private');
    expect(service.grants[0]?.['share_verifier']).toBeUndefined();
    expect(service.grants[0]?.['title']).toBeUndefined();

    const completion = service.completions[0];
    const seal = completion?.['seal'] as { signer_kind?: string } | undefined;
    const wraps = completion?.['wraps'] as unknown[] | undefined;
    expect(seal?.signer_kind).toBe('device');
    expect(wraps).toHaveLength(2);
  });

  test('refuses a title before any network call', async () => {
    const { service, fixture } = await confirmedMachine();
    await expect(
      publishPrivate({ path: SOURCE_PATH, title: 'Q3 numbers' }, fixture.deps)
    ).rejects.toMatchObject({ code: 'private_policy_violation' });
    expect(service.requests).toHaveLength(0);
  });

  test('refuses an explicit cover before any network call', async () => {
    const { service, fixture } = await confirmedMachine();
    await expect(
      publishPrivate({ path: SOURCE_PATH, cover: true }, fixture.deps)
    ).rejects.toMatchObject({ code: 'private_policy_violation' });
    expect(service.requests).toHaveLength(0);
    expect(fixture.renders.count).toBe(0);
  });

  test('refuses a lifetime above the server maximum before any grant', async () => {
    const { service, fixture } = await confirmedMachine();
    await expect(
      publishPrivate({ path: SOURCE_PATH, ttl_days: 366 }, fixture.deps)
    ).rejects.toMatchObject({ code: 'private_ttl_out_of_range' });
    expect(service.grants).toHaveLength(0);
    expect(service.uploads.size).toBe(0);
  });

  test('refuses against a server without private shares, before any upload', async () => {
    const { service, fixture } = await confirmedMachine({ capability: false });
    await expect(
      publishPrivate({ path: SOURCE_PATH }, fixture.deps)
    ).rejects.toMatchObject({
      code: 'private_unsupported',
    });
    expect(service.grants).toHaveLength(0);
    expect(service.uploads.size).toBe(0);
  });

  test('refuses before any request when no device is confirmed', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('unpinned');
    const service = new FakeService({ owner, device });
    const fixture = publishFixture(service, SOURCE, SOURCE_PATH);
    await expect(
      publishPrivate({ path: SOURCE_PATH }, fixture.deps)
    ).rejects.toMatchObject({
      code: 'device_not_enrolled',
    });
    expect(service.requests).toHaveLength(0);
  });

  test('refuses an uncertified device before wrapping anything', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('relic-mcp on the test machine');
    await pinDevice(ORIGIN, owner, device);
    const attacker = await makePerson('attacker@example.com');
    const forged = await makeDevice('forged device');
    const service = new FakeService({
      owner,
      device,
      extraDevices: [{ device: forged, signedBy: attacker }],
    });
    const fixture = publishFixture(service, SOURCE, SOURCE_PATH);
    await expect(
      publishPrivate({ path: SOURCE_PATH }, fixture.deps)
    ).rejects.toMatchObject({
      code: 'recipient_uncertified_device',
    });
    expect(service.grants).toHaveLength(0);
    expect(service.uploads.size).toBe(0);
  });

  test('refuses an owner the service names that is not the pinned owner', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('relic-mcp on the test machine');
    await pinDevice(ORIGIN, owner, device);
    const impostor = await makePerson('owner@example.com');
    const service = new FakeService({ owner, device, contextOwner: impostor });
    const fixture = publishFixture(service, SOURCE, SOURCE_PATH);
    await expect(
      publishPrivate({ path: SOURCE_PATH }, fixture.deps)
    ).rejects.toMatchObject({
      code: 'owner_pin_mismatch',
    });
    expect(service.grants).toHaveLength(0);
  });

  test('the lifetime defaults to the server default and is recorded', async () => {
    const { service, fixture } = await confirmedMachine();
    await publishPrivate({ path: SOURCE_PATH }, fixture.deps);
    expect(service.grants[0]?.['ttl_days']).toBe(30);
  });
});
