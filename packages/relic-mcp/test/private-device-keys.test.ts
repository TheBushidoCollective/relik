import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeBase64url,
  deviceIdOf,
  formatFingerprint,
  identityFingerprint,
} from '@relic/format/private';
import {
  confirmDevice,
  type DeviceEntry,
  enrollDevice,
  loadDeviceEntry,
} from '../src/device.ts';
import { publishStatePath } from '../src/state.ts';
import {
  makeCert,
  makePerson,
  ORIGIN,
  publishFixture,
  FakeService,
  makeDevice,
  DAY_MS,
} from './private-fixtures.ts';

const OTHER_ORIGIN = 'https://other.test';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-device-keys-'));
  // A directory the store has to create itself, so its mode is the writer's.
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'keys', 'device-keys.json');
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'keys', 'publish-state.json');
});

afterEach(async () => {
  delete process.env['RELIC_DEVICE_KEYS'];
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(dir, { recursive: true, force: true });
});

/**
 * A fake of the enrollment routes. The enrollment POST echoes the device id
 * the client derived, as the service does. The approval GET returns whatever
 * the test sets, so approval and the owner can be varied.
 */
function enrollmentService(
  approval: () => Record<string, unknown> | undefined
) {
  const posted: Record<string, unknown>[] = [];
  const fetch = async (
    url: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const path = new URL(String(url)).pathname;
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (init?.method === 'POST' && path === '/api/devices/enrollments') {
      const body = JSON.parse(String(init.body)) as Record<string, string>;
      posted.push(body);
      const deviceId = await deviceIdOf(
        decodeBase64url(body['kem_public_key'] ?? ''),
        decodeBase64url(body['sig_public_key'] ?? '')
      );
      return json(201, {
        enrollment_id: '01hh0m7x6ytcxbk2ckvd9p9w5a',
        approve_url: `${ORIGIN}/dashboard?approve-device=01hh0m7x6ytcxbk2ckvd9p9w5a`,
        expires_at: new Date(Date.now() + 900_000).toISOString(),
        device_id: deviceId,
      });
    }
    if (
      init?.method === undefined &&
      path.startsWith('/api/devices/enrollments/')
    ) {
      const body = approval();
      return body === undefined
        ? json(404, { code: 'device_not_found' })
        : json(200, body);
    }
    return json(404, { code: 'not_found' });
  };
  return { fetch, posted };
}

describe('device keys', () => {
  test('enrollment writes the key file 0600 in a 0700 directory and returns no key material', async () => {
    const service = enrollmentService(() => undefined);
    const fixture = publishFixture(
      new FakeService({
        owner: await makePerson('o@example.com'),
        device: await makeDevice('x'),
      }),
      new Uint8Array(),
      '/unused'
    );
    const deps = {
      ...fixture.deps,
      fetch: service.fetch as typeof globalThis.fetch,
    };

    const result = await enrollDevice({ label: 'test machine' }, deps);
    expect(result.status).toBe('pending');
    expect(result.device_fingerprint).toMatch(/^[0-9A-Z]{4}( [0-9A-Z]{4}){7}$/);

    const keysFile = process.env['RELIC_DEVICE_KEYS'] ?? '';
    expect((await stat(keysFile)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'keys'))).mode & 0o777).toBe(0o700);

    // The private scalar must not leave the file: not in the result, not in the
    // enrollment request the service received.
    const raw = await readFile(keysFile, 'utf8');
    const parsed = JSON.parse(raw) as { devices: Record<string, DeviceEntry> };
    const entry = parsed.devices[ORIGIN];
    const privateScalar = entry?.kem_private.jwk?.d ?? 'no scalar';
    expect(JSON.stringify(result).includes(privateScalar)).toBe(false);
    expect(JSON.stringify(service.posted).includes(privateScalar)).toBe(false);
  });

  test('the device is pending until the owner is pinned, and keys are partitioned by origin', async () => {
    const service = enrollmentService(() => undefined);
    const fixture = publishFixture(
      new FakeService({
        owner: await makePerson('o@example.com'),
        device: await makeDevice('x'),
      }),
      new Uint8Array(),
      '/unused'
    );
    await enrollDevice(
      {},
      { ...fixture.deps, fetch: service.fetch as typeof globalThis.fetch }
    );

    const pending = await loadDeviceEntry(ORIGIN);
    expect(pending?.enrollment).toBeDefined();
    expect(pending?.owner).toBeUndefined();
    expect(await loadDeviceEntry(OTHER_ORIGIN)).toBeUndefined();
    expect(publishStatePath().startsWith(dir)).toBe(true);
  });

  test('confirming with a wrong owner fingerprint pins nothing', async () => {
    const owner = await makePerson('owner@example.com');
    let approval: Record<string, unknown> | undefined;
    const service = enrollmentService(() => approval);
    const fixture = publishFixture(
      new FakeService({ owner, device: await makeDevice('x') }),
      new Uint8Array(),
      '/unused'
    );
    const deps = {
      ...fixture.deps,
      fetch: service.fetch as typeof globalThis.fetch,
    };
    await enrollDevice({ label: 'test machine' }, deps);
    const entry = await loadDeviceEntry(ORIGIN);
    if (entry === undefined) throw new Error('enrollment did not persist');

    const notAfter = Date.now() + 365 * DAY_MS;
    const cert = await makeCert({
      owner,
      device: {
        deviceId: entry.device_id,
        kem: entry.kem_public_key,
        sig: entry.sig_public_key,
        label: entry.label,
      },
      notAfter,
    });
    approval = {
      status: 'approved',
      device_id: entry.device_id,
      label: entry.label,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
      device: {
        device_id: entry.device_id,
        owner_identity_id: owner.identityId,
        kem_public_key: entry.kem_public_key,
        sig_public_key: entry.sig_public_key,
        label: entry.label,
        backend: 'file',
        not_after: notAfter,
        certified_at: new Date().toISOString(),
        revoked_at: null,
        cert,
      },
      owner: {
        email: owner.email,
        identity: {
          identity_id: owner.identityId,
          email: owner.email,
          kem_public_key: owner.kem,
          sig_public_key: owner.sig,
          created_at: new Date().toISOString(),
          retired_at: null,
        },
      },
    };

    await expect(
      confirmDevice(
        { owner_fingerprint: 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH' },
        deps
      )
    ).rejects.toMatchObject({ code: 'device_owner_fingerprint_mismatch' });
    expect((await loadDeviceEntry(ORIGIN))?.owner).toBeUndefined();

    // The right fingerprint pins, and only then.
    const right = formatFingerprint(
      await identityFingerprint(owner.identityId, owner.email)
    );
    const confirmed = await confirmDevice({ owner_fingerprint: right }, deps);
    expect(confirmed.status).toBe('confirmed');
    expect((await loadDeviceEntry(ORIGIN))?.owner?.identity_id).toBe(
      owner.identityId
    );
  });
});
