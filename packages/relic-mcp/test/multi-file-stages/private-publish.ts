import assert from 'node:assert/strict';
// Serialize stages that temporarily set the same local state paths.
import './folder-publish.ts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeKey,
  decodeManifest,
  streamAnyRelicContent,
} from '@relic/format';
import { decodeBase64url, kemKeyIdOf } from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../../src/files.ts';
import {
  republishPrivate,
  type PrivatePublishResult,
} from '../../src/private.ts';
import { handleMessage } from '../../src/server.ts';
import { loadPrivatePublishState } from '../../src/state.ts';
import {
  DAY_MS,
  makeCert,
  makeDevice,
  makePerson,
  pinDevice,
} from '../private-fixtures.ts';

const tmp = await mkdtemp(join(tmpdir(), 'relic-private-folder-'));
const previousDevice = process.env.RELIC_DEVICE_KEYS;
const previousState = process.env.RELIC_PUBLISH_STATE;
try {
  process.env.RELIC_DEVICE_KEYS = join(tmp, 'device.json');
  process.env.RELIC_PUBLISH_STATE = join(tmp, 'state.json');
  const root = join(tmp, 'confidential-folder');
  await mkdir(root);
  await writeFile(join(root, 'secret-name.md'), 'first');
  await writeFile(join(root, 'other.txt'), 'second');
  const store = new MemoryStore();
  const storage = new MemoryStorage();
  const app = createApp({ store, storage });
  const origin = 'https://relic.example';
  const owner = await makePerson('owner@example.com');
  const device = await makeDevice('private folder test');
  const now = Date.now();
  const kemId = async (key: string) =>
    Buffer.from(await kemKeyIdOf(decodeBase64url(key))).toString('hex');
  const attestation = {
    statements: [],
    nonce: 'nonce',
    credential: {} as never,
    credentialId: 'cred',
    credentialPublicKeyJwk: { kty: 'EC' },
    credentialAlg: -7 as const,
    rpId: 'relic.example',
    origin,
    verifiedAt: now,
  };
  assert.equal(
    await store.createIdentity({
      identityId: owner.identityId,
      email: owner.email,
      address: owner.email,
      kemPublicKey: owner.kem,
      sigPublicKey: owner.sig,
      kemKeyId: await kemId(owner.kem),
      createdAt: now,
      registration: attestation,
      credentials: [],
      accessLogRetentionDays: 2190,
      recipientsEpoch: 0,
    }),
    'created'
  );
  const cert = await makeCert({ owner, device, notAfter: now + 365 * DAY_MS });
  await store.putDevice({
    deviceId: device.deviceId,
    ownerIdentityId: owner.identityId,
    kemPublicKey: device.kem,
    sigPublicKey: device.sig,
    kemKeyId: await kemId(device.kem),
    label: device.label,
    backend: 'file',
    notAfter: now + 365 * DAY_MS,
    certifiedAt: now,
    cert: {
      ...attestation,
      statements: [
        {
          kind: 'device_cert',
          statement: cert.statement,
          identitySignature: cert.identity_signature,
        },
      ],
    },
  });
  await pinDevice(origin, owner, device);
  const requests: string[] = [];
  let lastObjectKey = '';
  const deps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    files: nodeFiles,
    clientName: 'private-folder-test',
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(
        `${String(input)} ${typeof init?.body === 'string' ? init.body : ''}`
      );
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(String(input), { ...init, headers }));
    }) as typeof fetch,
    upload: async (
      url: string,
      _headers: Record<string, string>,
      body: Uint8Array
    ) => {
      requests.push(url);
      lastObjectKey = new URL(url).pathname.slice('/upload/'.length);
      storage.put(lastObjectKey, body);
      return { status: 200 };
    },
    renderCover: async () => ({
      status: 'skipped' as const,
      reason: 'browser_disabled' as const,
      detail: 'test',
    }),
  };
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'relic_publish',
        arguments: { path: root, private: true, open_first: 'other.txt' },
      },
    },
    deps
  );
  assert.ok(response?.result);
  const result = response.result as {
    isError: boolean;
    structuredContent: PrivatePublishResult;
  };
  assert.equal(result.isError, false);
  const first = result.structuredContent;
  assert.equal(first.shape, 'folder');
  assert.equal(first.folder?.default_entry, 'other.txt');
  const state = await loadPrivatePublishState(first.relic_id);
  assert.equal(state?.shape, 'folder');
  const ciphertext = await storage.read(first.relic_id);
  assert.ok(ciphertext && state);
  const chunks: Uint8Array[] = [];
  const envelope = await streamAnyRelicContent(
    new Blob([ciphertext as BlobPart]).stream(),
    decodeKey(state.version_keys['1']!),
    {
      objectLength: ciphertext.length,
      onContent: (chunk) => {
        chunks.push(chunk);
      },
    }
  );
  assert.equal(envelope.version, 2);
  if (!('manifestLength' in envelope)) throw new Error('expected folder');
  const plain = Buffer.concat(chunks);
  const manifest = decodeManifest(
    plain.subarray(0, envelope.manifestLength),
    envelope
  );
  assert.equal(manifest.entries[manifest.defaultIndex]?.path, 'other.txt');
  assert.equal(
    plain.subarray(envelope.manifestLength).toString(),
    'secondfirst'
  );
  await writeFile(join(root, 'secret-name.md'), 'updated');
  const next = await republishPrivate(
    { relic_id: first.relic_id, path: root },
    deps
  );
  const nextState = await loadPrivatePublishState(first.relic_id);
  assert.equal(next.version, 2);
  assert.equal(nextState?.shape, 'folder');
  assert.notEqual(nextState?.version_keys['1'], nextState?.version_keys['2']);
  const nextCiphertext = await storage.read(lastObjectKey);
  assert.ok(nextCiphertext && nextState);
  const nextChunks: Uint8Array[] = [];
  const nextEnvelope = await streamAnyRelicContent(
    new Blob([nextCiphertext as BlobPart]).stream(),
    decodeKey(nextState.version_keys['2']!),
    {
      objectLength: nextCiphertext.length,
      onContent: (chunk) => {
        nextChunks.push(chunk);
      },
    }
  );
  assert.equal(nextEnvelope.version, 2);
  if (!('manifestLength' in nextEnvelope)) throw new Error('expected folder');
  assert.equal(
    Buffer.concat(nextChunks).subarray(nextEnvelope.manifestLength).toString(),
    'secondupdated'
  );
  await assert.rejects(
    streamAnyRelicContent(
      new Blob([nextCiphertext as BlobPart]).stream(),
      decodeKey(nextState.version_keys['1']!),
      { objectLength: nextCiphertext.length, onContent: () => {} }
    )
  );
  for (const request of requests) {
    assert.ok(!request.includes(root));
    assert.ok(!request.includes('secret-name.md'));
    assert.ok(!request.includes('other.txt'));
  }
  console.log('MULTI_FILE_STAGE private-publish OK');
} finally {
  if (previousDevice === undefined) delete process.env.RELIC_DEVICE_KEYS;
  else process.env.RELIC_DEVICE_KEYS = previousDevice;
  if (previousState === undefined) delete process.env.RELIC_PUBLISH_STATE;
  else process.env.RELIC_PUBLISH_STATE = previousState;
  await rm(tmp, { recursive: true, force: true });
}
