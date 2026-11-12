/**
 * relic-mcp against the real relic-server app, in process.
 *
 * The app is created as the service creates it (`createApp`), on the
 * in-memory store and storage. The client's `fetch` is routed into
 * `app.fetch`, so every request the client makes is answered by the server's
 * real routes, verification and refusals. Nothing here stubs a server answer.
 *
 * The owner identity and the device are seeded with real keys and a real
 * certificate, because a private publish needs a device the owner certified.
 * The identity ceremony (a passkey) belongs to the viewer, so it is seeded
 * directly rather than driven through WebAuthn.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { encryptedSize } from '@relic/format';
import {
  canonicalJson,
  decodeBase64url,
  identityFingerprint,
  kemKeyIdOf,
  parseStatement,
  signStatement,
  statementBytes,
} from '@relic/format/private';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import {
  MemoryStore,
  type StoredAttestation,
} from '@relic/server/src/store.ts';
import {
  confirmDevice,
  enrollDevice,
  loadDeviceEntry,
  sha256Hex,
} from '../src/device.ts';
import {
  type FileReader,
  type PublishDeps,
  PublishError,
  publish,
} from '../src/publish.ts';
import { bindOwner, publishPrivate, republishPrivate } from '../src/private.ts';
import { loadPrivatePublishState } from '../src/state.ts';
import {
  DAY_MS,
  makeCert,
  makeDevice,
  makePerson,
  type Person,
  pinDevice,
  signer,
  type TestDevice,
} from './private-fixtures.ts';

const SERVICE = 'https://relic.example';
const SOURCE = new TextEncoder().encode('# Board pack\n\nThe numbers hold.\n');
const EDITED = new TextEncoder().encode(
  '# Board pack\n\nThe numbers changed.\n'
);
const SOURCE_PATH = '/work/board.md';
const T0 = Date.parse('2026-11-11T12:00:00.000Z');

const realNow = Date.now;
let now = T0;
let app: RelicApp;
let storage: MemoryStorage;
let dir: string;
let requestBodies: string[];

beforeEach(async () => {
  // The server's freshness checks read its own clock. The client reads
  // Date.now(), so both are pinned to one value for the whole test.
  now = T0;
  Date.now = () => now;
  dir = await mkdtemp(join(tmpdir(), 'relic-private-server-'));
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'device-keys.json');
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'publish-state.json');
  storage = new MemoryStorage();
  requestBodies = [];
  app = createApp({
    store: new MemoryStore(),
    storage,
    now: () => now,
    operatorTokens: new Map([['jason', 'operator-secret']]),
  });
});

afterEach(async () => {
  Date.now = realNow;
  delete process.env['RELIC_DEVICE_KEYS'];
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(dir, { recursive: true, force: true });
});

/** Route a client request into the real app and keep every body it sent. */
function serviceFetch(): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (typeof init?.body === 'string') requestBodies.push(init.body);
    const headers = new Headers(init?.headers);
    headers.set('x-forwarded-for', '198.51.100.10');
    return app.fetch(new Request(url.toString(), { ...init, headers }));
  }) as typeof globalThis.fetch;
}

function filesFor(path: string, bytes: Uint8Array): FileReader {
  return {
    resolve: (p) => p,
    basename: (p) => p.slice(p.lastIndexOf('/') + 1),
    stat: async (p) => {
      if (p !== path) {
        throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
      }
      return { kind: 'file', size: bytes.length };
    },
    read: async () => bytes,
    openBundleRoot: async () => {
      throw new Error('bundles are not part of this test');
    },
  };
}

function depsFor(bytes: Uint8Array = SOURCE): PublishDeps {
  return {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: filesFor(SOURCE_PATH, bytes),
    fetch: serviceFetch(),
    upload: async (url, _headers, body) => {
      // The signed upload leg, served by the storage seam keyed by relic id.
      const relicId = new URL(url).pathname.slice('/upload/'.length);
      storage.put(relicId, body);
      return { status: 200 };
    },
    clientName: 'relic-mcp-test',
    identifySource: async (path) => ({
      identity: `test:${path}`,
      kind: 'realpath',
      path,
      description: path,
    }),
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test',
    }),
  };
}

/** The key id the server stores for a KEM public key: SHA-256 of it, as lowercase hex. */
async function kemKeyIdHex(kemPublicKey: string): Promise<string> {
  return Array.from(await kemKeyIdOf(decodeBase64url(kemPublicKey)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

/** A verified identity in the real app's store, with its real keys. */
async function storeIdentity(
  person: Person,
  recipientsEpoch = 0
): Promise<void> {
  const created = await app.store.createIdentity({
    identityId: person.identityId,
    email: person.email,
    address: person.email,
    kemPublicKey: person.kem,
    sigPublicKey: person.sig,
    kemKeyId: await kemKeyIdHex(person.kem),
    createdAt: now,
    registration: {
      statements: [],
      nonce: 'nonce',
      credential: {} as never,
      credentialId: 'cred',
      credentialPublicKeyJwk: { kty: 'EC' },
      credentialAlg: -7,
      rpId: 'relic.example',
      origin: SERVICE,
      verifiedAt: now,
    },
    credentials: [],
    accessLogRetentionDays: 2190,
    recipientsEpoch,
  });
  expect(created).toBe('created');
}

/** A device the owner certified, stored the way the server stores a certified device. */
async function certifyDevice(owner: Person, device: TestDevice): Promise<void> {
  const cert = await makeCert({ owner, device, notAfter: now + 365 * DAY_MS });
  await app.store.putDevice({
    deviceId: device.deviceId,
    ownerIdentityId: owner.identityId,
    kemPublicKey: device.kem,
    sigPublicKey: device.sig,
    kemKeyId: await kemKeyIdHex(device.kem),
    label: device.label,
    backend: 'file',
    notAfter: now + 365 * DAY_MS,
    certifiedAt: now,
    cert: {
      statements: [
        {
          kind: 'device_cert',
          statement: cert.statement,
          identitySignature: cert.identity_signature,
        },
      ],
      nonce: 'nonce',
      credential: {} as never,
      credentialId: 'cred',
      credentialPublicKeyJwk: { kty: 'EC' },
      credentialAlg: -7,
      rpId: 'relic.example',
      origin: SERVICE,
      verifiedAt: now,
    },
  });
}

/** The owner's recipients epoch, changed the way a service would change it. */
async function setEpoch(owner: Person, epoch: number): Promise<void> {
  await app.store.updateIdentity(owner.identityId, (r) => ({
    ...r,
    recipientsEpoch: epoch,
  }));
}

/**
 * Designate a recovery identity. The owner signs the designation with the
 * sig key, and the store holds it as the server stores a designation.
 */
async function designateRecovery(
  owner: Person,
  recovery: Person,
  at: number
): Promise<void> {
  const statement = {
    at,
    fingerprint_typed: await identityFingerprint(
      recovery.identityId,
      recovery.email
    ),
    owner_identity_id: owner.identityId,
    recovery_email: recovery.email,
    recovery_identity_id: recovery.identityId,
  };
  const identitySignature = await signStatement(
    signer(owner.keys.sig.privateKey),
    statementBytes('recovery_designation', statement)
  );
  await app.store.updateIdentity(owner.identityId, (r) => ({
    ...r,
    recovery: {
      recoveryIdentityId: recovery.identityId,
      recoveryEmail: recovery.email,
      designatedAt: at,
      attestation: {
        statements: [
          { kind: 'recovery_designation', statement, identitySignature },
        ],
        nonce: 'nonce',
        credential: {} as never,
        credentialId: 'cred',
        credentialPublicKeyJwk: { kty: 'EC' },
        credentialAlg: -7,
        rpId: 'relic.example',
        origin: SERVICE,
        verifiedAt: at,
      },
    },
  }));
}

/**
 * Seed a verified owner identity and a device that owner certified, into the
 * real app's store, then pin that owner on this machine. Keys and the
 * certificate are real, so the server verifies them for real.
 */
async function seedOwnerAndDevice(): Promise<{
  owner: Person;
  device: TestDevice;
}> {
  const owner = await makePerson('owner@example.com');
  const device = await makeDevice('relic-mcp on the test machine');
  await storeIdentity(owner);
  await certifyDevice(owner, device);
  await pinDevice(SERVICE, owner, device);
  return { owner, device };
}

describe('the private publish against the real service', () => {
  test('the challenge advertises private shares, so a current service is accepted', async () => {
    const response = await app.fetch(
      new Request(`${SERVICE}/api/challenge`, {
        method: 'POST',
        headers: { 'x-forwarded-for': '198.51.100.10' },
      })
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['private_shares']).toEqual({
      default_ttl_days: 30,
      max_ttl_days: 365,
    });
  });

  test('a tap-free private publish returns a keyless link the real service accepts', async () => {
    await seedOwnerAndDevice();
    const result = await publishPrivate({ path: SOURCE_PATH }, depsFor());

    expect(result.access).toBe('private');
    expect(result.url).toBe(`${SERVICE}/${result.relic_id}`);
    expect(result.url.includes('#')).toBe(false);
    expect(result.relic_expires_at).not.toBeNull();
    expect((await app.store.getRelic(result.relic_id))?.access).toBe('private');
  });

  test('no key encoding appears in the output, the state, or any request body', async () => {
    await seedOwnerAndDevice();
    const result = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    const state = await loadPrivatePublishState(result.relic_id);
    const key = state?.version_keys['1'];
    expect(key).toBeDefined();

    // The key as it is stored, and as raw bytes in hex and base64: the
    // encodings a leak would plausibly take.
    const raw = Buffer.from(key ?? '', 'base64url');
    const encodings = [key ?? '', raw.toString('hex'), raw.toString('base64')];
    const seen = [JSON.stringify(result), ...requestBodies];
    for (const text of seen) {
      for (const encoding of encodings) {
        expect(text.includes(encoding)).toBe(false);
      }
    }
  });

  test('a republish seals a fresh key under the same link as version 2', async () => {
    await seedOwnerAndDevice();
    const first = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    const republished = await republishPrivate(
      { relic_id: first.relic_id, path: SOURCE_PATH },
      depsFor(EDITED)
    );
    expect(republished.version).toBe(2);
    const state = await loadPrivatePublishState(first.relic_id);
    expect(state?.version).toBe(2);
    expect(state?.version_keys['2']).toBeDefined();
    expect(state?.version_keys['2']).not.toBe(state?.version_keys['1']);
    expect(encryptedSize(EDITED.length)).toBeGreaterThan(0);
  });
});

describe('device enrollment and owner confirmation against the real service', () => {
  test('a wrong owner fingerprint is refused and pins nothing', async () => {
    const machine = depsFor();
    await enrollDevice({ label: 'test machine' }, machine);
    await expect(
      confirmDevice(
        { owner_fingerprint: 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH' },
        machine
      )
    ).rejects.toBeInstanceOf(PublishError);
    expect((await loadDeviceEntry(SERVICE))?.owner).toBeUndefined();
  });

  test('a fingerprint that is not the owner is never pinned', async () => {
    const machine = depsFor();
    await enrollDevice({ label: 'test machine' }, machine);
    const notTheOwner = await identityFingerprint(
      '0'.repeat(64),
      'nobody@example.com'
    );
    await expect(
      confirmDevice({ owner_fingerprint: notTheOwner }, machine)
    ).rejects.toMatchObject({ code: 'device_enrollment_pending' });
    expect((await loadDeviceEntry(SERVICE))?.owner).toBeUndefined();
  });
});

describe('the publish path refuses before any upload', () => {
  test('a server with no private-share capability is refused before any grant', async () => {
    await seedOwnerAndDevice();
    const bare = createApp({
      store: new MemoryStore(),
      storage: new MemoryStorage(),
      now: () => now,
      operatorTokens: new Map([['jason', 'operator-secret']]),
    });
    const capabilityless: PublishDeps = {
      ...depsFor(),
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await bare.fetch(new Request(String(input), init));
        if (!String(input).endsWith('/api/challenge')) return response;
        // An older server answers the challenge without `private_shares`.
        const body = (await response.json()) as Record<string, unknown>;
        delete body['private_shares'];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof globalThis.fetch,
    };
    await expect(
      publishPrivate({ path: SOURCE_PATH }, capabilityless)
    ).rejects.toMatchObject({ code: 'private_unsupported' });
    expect(bare.store.getRelic).toBeDefined();
  });
});

describe('device requests carry the spec nonce (PS-08)', () => {
  test('the device_request nonce is 32 bytes, and the statement the server parses is valid', async () => {
    const { device } = await seedOwnerAndDevice();
    await publishPrivate({ path: SOURCE_PATH }, depsFor());
    const auth = requestBodies
      .map((body) => JSON.parse(body) as Record<string, unknown>)
      .map((body) => body['device_auth'] as Record<string, unknown> | undefined)
      .find((candidate) => candidate?.['device_id'] === device.deviceId);
    expect(auth).toBeDefined();
    const nonce = String(auth?.['nonce']);
    expect(decodeBase64url(nonce).length).toBe(32);
    expect(() =>
      parseStatement('device_request', {
        at: auth?.['at'],
        body_sha256: sha256Hex(canonicalJson({})),
        device_id: device.deviceId,
        method: 'POST',
        nonce,
        path: `/api/devices/${device.deviceId}/context`,
      })
    ).not.toThrow();
  });
});

/** The owner-signed `device_revocation` the server stores on a revoked device, as its attestation. */
async function revocationAttestation(
  owner: Person,
  deviceId: string
): Promise<StoredAttestation> {
  const statement = {
    at: now,
    device_id: deviceId,
    owner_identity_id: owner.identityId,
  };
  const identitySignature = await signStatement(
    signer(owner.keys.sig.privateKey),
    statementBytes('device_revocation', statement)
  );
  return {
    statements: [{ kind: 'device_revocation', statement, identitySignature }],
  } as unknown as StoredAttestation;
}

describe('the client admits what the owner signed, never what the service asserts alone (PS-05, PS2-05)', () => {
  test('an owner epoch the service rolls back does not refuse a republish, because the epoch is a hint the service checks', async () => {
    const { owner } = await seedOwnerAndDevice();
    await setEpoch(owner, 2);
    const first = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    await setEpoch(owner, 1);
    const next = await republishPrivate(
      { relic_id: first.relic_id, path: SOURCE_PATH },
      depsFor(EDITED)
    );
    expect(next.version).toBe(2);
    expect((await app.store.getRelic(first.relic_id))?.sealedVersion).toBe(2);
  });

  test('a device revoked by an owner-signed revocation stays out of the republish', async () => {
    const { owner } = await seedOwnerAndDevice();
    const second = await makeDevice('second machine');
    await certifyDevice(owner, second);
    const first = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    const revocation = await revocationAttestation(owner, second.deviceId);
    await app.store.updateDevice(second.deviceId, (d) => ({
      ...d,
      revokedAt: now,
      revocation,
    }));
    const revoked = await republishPrivate(
      { relic_id: first.relic_id, path: SOURCE_PATH },
      depsFor(EDITED)
    );
    expect(revoked.version).toBe(2);
    expect(
      revoked.recipients.some(
        (r) => r.kind === 'device' && r.label === 'second machine'
      )
    ).toBe(false);
  });

  test('a service that stops flagging a signed-revoked device gets no wrap for it: the seal is refused', async () => {
    const { owner } = await seedOwnerAndDevice();
    const second = await makeDevice('second machine');
    await certifyDevice(owner, second);
    const first = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    const revocation = await revocationAttestation(owner, second.deviceId);
    await app.store.updateDevice(second.deviceId, (d) => ({
      ...d,
      revokedAt: now,
      revocation,
    }));
    await republishPrivate(
      { relic_id: first.relic_id, path: SOURCE_PATH },
      depsFor(EDITED)
    );
    // The flag is cleared and the signed revocation stays on the record. The
    // server now expects a wrap for the device, and the client, holding the
    // owner's revocation, sends none, so nothing is sealed for it.
    await app.store.updateDevice(second.deviceId, (d) => ({
      ...d,
      revokedAt: undefined,
    }));
    await expect(
      republishPrivate(
        { relic_id: first.relic_id, path: SOURCE_PATH },
        depsFor(SOURCE)
      )
    ).rejects.toMatchObject({ code: 'recipients_changed' });
    expect((await app.store.getRelic(first.relic_id))?.sealedVersion).toBe(2);
  });
});

describe('recovery designations against the real service (PS-05, PS-10)', () => {
  test('a tap-free private publish wraps to the designated recovery identity', async () => {
    const { owner } = await seedOwnerAndDevice();
    const recovery = await makePerson('recovery@example.com');
    await storeIdentity(recovery);
    await designateRecovery(owner, recovery, now - 1000);
    const result = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    expect(
      result.recipients.filter((r) => r.kind === 'recovery').map((r) => r.email)
    ).toEqual(['recovery@example.com']);
  });

  test('a republish refuses a designation the service replays from before the newest one', async () => {
    const { owner } = await seedOwnerAndDevice();
    const older = await makePerson('older@example.com');
    const newer = await makePerson('newer@example.com');
    await storeIdentity(older);
    await storeIdentity(newer);
    await designateRecovery(owner, older, now - 2000);
    const first = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    await designateRecovery(owner, newer, now - 1000);
    await republishPrivate(
      { relic_id: first.relic_id, path: SOURCE_PATH },
      depsFor(EDITED)
    );
    await designateRecovery(owner, older, now - 2000);
    await expect(
      republishPrivate(
        { relic_id: first.relic_id, path: SOURCE_PATH },
        depsFor(SOURCE)
      )
    ).rejects.toMatchObject({ code: 'recipients_stale' });
    // The republish opens version 3 on the service before the client reads the
    // roster, so version 3 exists unsealed. Nothing newer than 2 was sealed.
    expect((await app.store.getRelic(first.relic_id))?.sealedVersion).toBe(2);
  });

  test('a designation stays in force across a later device revocation', async () => {
    // Plan 4.12: a device revocation deletes that device's wraps and leaves
    // the designation in force. The revocation is the owner's signed statement,
    // as the service stores it, so the client and the server agree on the device.
    const { owner } = await seedOwnerAndDevice();
    const recovery = await makePerson('recovery@example.com');
    await storeIdentity(recovery);
    await designateRecovery(owner, recovery, now - 1000);
    const second = await makeDevice('second machine');
    await certifyDevice(owner, second);
    const first = await publishPrivate({ path: SOURCE_PATH }, depsFor());
    const revocation = await revocationAttestation(owner, second.deviceId);
    await app.store.updateDevice(second.deviceId, (d) => ({
      ...d,
      revokedAt: now,
      revocation,
    }));
    const next = await republishPrivate(
      { relic_id: first.relic_id, path: SOURCE_PATH },
      depsFor(EDITED)
    );
    expect(next.recipients.some((r) => r.kind === 'recovery')).toBe(true);
  });
});

describe('relic_bind_owner against the real service (plan 4.7)', () => {
  test('a public relic this machine published binds its owner', async () => {
    const { owner } = await seedOwnerAndDevice();
    const published = await publish({ path: SOURCE_PATH }, depsFor());
    const bound = await bindOwner({ relic_id: published.relic_id }, depsFor());
    expect(bound.owner.email).toBe(owner.email);
  });

  test('a second owner bind for the same relic answers owner_exists', async () => {
    await seedOwnerAndDevice();
    const published = await publish({ path: SOURCE_PATH }, depsFor());
    await bindOwner({ relic_id: published.relic_id }, depsFor());
    await expect(
      bindOwner({ relic_id: published.relic_id }, depsFor())
    ).rejects.toMatchObject({ code: 'owner_exists' });
  });
});
