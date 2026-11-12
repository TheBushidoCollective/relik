/**
 * `privateVersionKey` reads a version this device did not publish. A seal made
 * before a grant does not list the grantee's device, so the wrap addressed to
 * the device is what decides: it opens the key or it is refused.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodeBase64url,
  encodeBase64url,
  keyCommitment,
  signStatement,
  statementBytes,
  wrapVersionKey,
} from '@relic/format/private';

import { privateVersionKey } from '../src/private.ts';
import type { PublishDeps } from '../src/publish.ts';
import type { PrivatePublishState } from '../src/state.ts';
import {
  FakeService,
  jsonResponse,
  makeDevice,
  makePerson,
  ORIGIN,
  type Person,
  pinDevice,
  publishFixture,
  sha256Hex,
  type TestDevice,
} from './private-fixtures.ts';

const RELIC_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const VERSION = 2;
const KEY_PATH = `/api/relics/${RELIC_ID}/versions/${VERSION}/key`;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-version-key-'));
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'device-keys.json');
});

afterEach(async () => {
  delete process.env['RELIC_DEVICE_KEYS'];
  await rm(dir, { recursive: true, force: true });
});

interface KeyResponseOptions {
  /** The key ids the seal lists. A grant made after the seal leaves a device out. */
  readonly sealRecipients: readonly string[];
  /** The device whose KEM key the wrap is sealed to. */
  readonly wrapTo: TestDevice;
  /** The key id the wrap names as its recipient. */
  readonly recipientKeyId: string;
  /** Whether the last byte of the wrap's ciphertext is altered. */
  readonly tamper?: boolean;
  /** Whether the wrap carries a key the service chose, not the one the seal commits to. */
  readonly substituteKey?: boolean;
}

/** The key response the service answers for one version, sealed by the owner. */
async function keyResponse(
  owner: Person,
  key: Uint8Array,
  options: KeyResponseOptions
): Promise<Record<string, unknown>> {
  const sealStatement = {
    access_epoch: 0,
    at: Date.UTC(2026, 10, 11),
    ciphertext_sha256: sha256Hex(new Uint8Array([1, 2, 3])),
    key_commitment: await keyCommitment({
      relicId: RELIC_ID,
      version: VERSION,
      key,
    }),
    owner_epoch: 0,
    recipient_key_ids: [...options.sealRecipients].sort(),
    relic_id: RELIC_ID,
    signer_id: owner.identityId,
    version: VERSION,
  };
  const signature = await signStatement(
    async (message) =>
      new Uint8Array(
        await crypto.subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          owner.keys.sig.privateKey,
          new Uint8Array(message)
        )
      ),
    statementBytes('seal', sealStatement)
  );
  const wrap = await wrapVersionKey({
    recipientPublicKey: options.wrapTo.keys.kemPublicKey,
    relicId: RELIC_ID,
    version: VERSION,
    key: options.substituteKey
      ? crypto.getRandomValues(new Uint8Array(16))
      : key,
  });
  const ct = options.tamper
    ? encodeBase64url(
        decodeBase64url(wrap.ct).map((byte, index, bytes) =>
          index === bytes.length - 1 ? byte ^ 1 : byte
        )
      )
    : wrap.ct;
  return {
    relic_id: RELIC_ID,
    version: VERSION,
    wrap: {
      recipient_key_id: options.recipientKeyId,
      version: VERSION,
      enc: wrap.enc,
      ct,
    },
    seal: { statement: sealStatement, signature, signer_kind: 'identity' },
    signer: { kind: 'identity' },
    owner: {
      email: owner.email,
      identity: {
        identity_id: owner.identityId,
        email: owner.email,
        kem_public_key: encodeBase64url(owner.keys.kemPublicKey),
        sig_public_key: encodeBase64url(owner.keys.sigPublicKey),
        created_at: '2026-11-01T00:00:00Z',
        retired_at: null,
      },
    },
  };
}

/** Publish deps whose key route answers with `body`, and whose other routes are the fake service's. */
function depsAnswering(
  service: FakeService,
  body: Record<string, unknown>
): PublishDeps {
  const fixture = publishFixture(service, new TextEncoder().encode('x'));
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith(KEY_PATH)) {
      return jsonResponse(200, body);
    }
    return service.fetch(url, init);
  }) as typeof globalThis.fetch;
  return { ...fixture.deps, fetch };
}

/** The publish state this device holds for the relic: it published version 1, not 2. */
function stateFor(owner: Person, device: TestDevice): PrivatePublishState {
  return {
    access: 'private',
    service_origin: ORIGIN,
    publish_token: 'publish-token-for-version-key-test',
    version: 1,
    version_keys: {},
    owner_identity_id: owner.identityId,
    device_id: device.deviceId,
  };
}

describe('privateVersionKey reads a version this device did not publish', () => {
  test('a device the seal does not list opens the version through the wrap addressed to it', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('relic-mcp on the test machine');
    await pinDevice(ORIGIN, owner, device);
    const key = crypto.getRandomValues(new Uint8Array(16));
    const service = new FakeService({ owner, device });
    const body = await keyResponse(owner, key, {
      sealRecipients: [sha256Hex(owner.keys.kemPublicKey)],
      wrapTo: device,
      recipientKeyId: sha256Hex(device.keys.kemPublicKey),
    });

    const opened = await privateVersionKey(
      depsAnswering(service, body),
      RELIC_ID,
      stateFor(owner, device),
      VERSION
    );

    expect(opened).toEqual(key);
  });

  test('a wrap addressed to another device is refused, even when the seal lists this device', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('relic-mcp on the test machine');
    await pinDevice(ORIGIN, owner, device);
    const other = await makeDevice('another device');
    const key = crypto.getRandomValues(new Uint8Array(16));
    const service = new FakeService({ owner, device });
    const body = await keyResponse(owner, key, {
      sealRecipients: [sha256Hex(device.keys.kemPublicKey)],
      wrapTo: other,
      recipientKeyId: sha256Hex(other.keys.kemPublicKey),
    });

    await expect(
      privateVersionKey(
        depsAnswering(service, body),
        RELIC_ID,
        stateFor(owner, device),
        VERSION
      )
    ).rejects.toMatchObject({ code: 'wrap_unopenable' });
  });

  test('a tampered wrap addressed to this device is refused', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('relic-mcp on the test machine');
    await pinDevice(ORIGIN, owner, device);
    const key = crypto.getRandomValues(new Uint8Array(16));
    const service = new FakeService({ owner, device });
    const body = await keyResponse(owner, key, {
      sealRecipients: [sha256Hex(device.keys.kemPublicKey)],
      wrapTo: device,
      recipientKeyId: sha256Hex(device.keys.kemPublicKey),
      tamper: true,
    });

    await expect(
      privateVersionKey(
        depsAnswering(service, body),
        RELIC_ID,
        stateFor(owner, device),
        VERSION
      )
    ).rejects.toMatchObject({ code: 'wrap_unopenable' });
  });
});
describe('privateVersionKey refuses a key the seal does not commit to', () => {
  test('a wrap of a substituted key opens, but the key is refused before it is used', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('relic-mcp on the test machine');
    await pinDevice(ORIGIN, owner, device);
    const key = crypto.getRandomValues(new Uint8Array(16));
    const service = new FakeService({ owner, device });
    const body = await keyResponse(owner, key, {
      sealRecipients: [sha256Hex(device.keys.kemPublicKey)],
      wrapTo: device,
      recipientKeyId: sha256Hex(device.keys.kemPublicKey),
      substituteKey: true,
    });

    await expect(
      privateVersionKey(
        depsAnswering(service, body),
        RELIC_ID,
        stateFor(owner, device),
        VERSION
      )
    ).rejects.toMatchObject({ code: 'seal_key_mismatch' });
  });
});
