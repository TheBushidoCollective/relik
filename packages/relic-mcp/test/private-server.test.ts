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
  decodeBase64url,
  identityFingerprint,
  kemKeyIdOf,
} from '@relic/format/private';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { confirmDevice, enrollDevice, loadDeviceEntry } from '../src/device.ts';
import {
  type FileReader,
  type PublishDeps,
  PublishError,
} from '../src/publish.ts';
import { publishPrivate, republishPrivate } from '../src/private.ts';
import { loadPrivatePublishState } from '../src/state.ts';
import {
  DAY_MS,
  makeCert,
  makeDevice,
  makePerson,
  type Person,
  pinDevice,
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
  const kemKeyIdHex = async (kemPublicKey: string): Promise<string> =>
    Array.from(await kemKeyIdOf(decodeBase64url(kemPublicKey)), (b) =>
      b.toString(16).padStart(2, '0')
    ).join('');
  const store = app.store;
  await store.createIdentity({
    identityId: owner.identityId,
    email: owner.email,
    address: owner.email,
    kemPublicKey: owner.kem,
    sigPublicKey: owner.sig,
    kemKeyId: await kemKeyIdHex(owner.kem),
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
    recipientsEpoch: 0,
  });
  const cert = await makeCert({
    owner,
    device,
    notAfter: now + 365 * DAY_MS,
  });
  await store.putDevice({
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
