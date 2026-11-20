import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  crc32,
  decodeKey,
  decodeManifest,
  openAnyRelic,
  streamAnyRelicContent,
} from '@relic/format';
import { decodeBase64url, kemKeyIdOf } from '@relic/format/private';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../../src/files.ts';
import { PublishError } from '../../src/publish.ts';
import {
  publishPrivate,
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

type Entry = {
  name: string | Buffer;
  body?: string;
  symlink?: boolean;
  encrypted?: boolean;
  size?: number;
  deflate?: boolean;
};
function zip(entries: Entry[], zip64 = false): Buffer {
  const parts: Buffer[] = [],
    central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name),
      data = Buffer.from(e.body ?? ''),
      packed = e.deflate ? deflateRawSync(data) : data;
    const flags = e.encrypted ? 1 : 0,
      method = e.deflate ? 8 : 0,
      crc = crc32(data),
      size = e.size ?? data.length;
    const local = Buffer.alloc(30),
      cd = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    cd.writeUInt32LE(0x02014b50);
    cd.writeUInt16LE(0x0314, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(packed.length, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(((e.symlink ? 0xa1ff : 0x81a4) << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, packed);
    central.push(cd, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}
const tmp = await mkdtemp(join(tmpdir(), 'relic-private-zip-'));
const previousDevice = process.env.RELIC_DEVICE_KEYS,
  previousState = process.env.RELIC_PUBLISH_STATE;
try {
  process.env.RELIC_DEVICE_KEYS = join(tmp, 'device.json');
  process.env.RELIC_PUBLISH_STATE = join(tmp, 'state.json');
  const store = new MemoryStore(),
    storage = new MemoryStorage(),
    app = createApp({ store, storage });
  const origin = 'https://relic.example',
    owner = await makePerson('owner@example.com'),
    device = await makeDevice('private zip test'),
    now = Date.now();
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
    clientName: 'private-zip-test',
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
  const file = join(tmp, 'source.zip');
  const original = zip([
    { name: 'secret-entry.md', body: 'hello', deflate: true },
    { name: 'private-data.txt', body: 'stored' },
    { name: '__MACOSX/._hidden', body: 'metadata' },
    { name: 'private-link', body: 'target', symlink: true },
  ]);
  await writeFile(file, original);
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'relic_publish',
        arguments: { path: file, private: true },
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
  assert.equal(first.folder?.source, 'zip');
  assert.deepEqual(first.folder?.left_out.by_reason, {
    os_metadata: 1,
    symlink: 1,
  });
  const state = await loadPrivatePublishState(first.relic_id),
    ciphertext = await storage.read(first.relic_id);
  assert.ok(state && ciphertext);
  const chunks: Uint8Array[] = [];
  const header = await streamAnyRelicContent(
    new Blob([ciphertext as BlobPart]).stream(),
    decodeKey(state.version_keys['1']!),
    {
      objectLength: ciphertext.length,
      onContent: (chunk) => {
        chunks.push(chunk);
      },
    }
  );
  assert.equal(header.version, 2);
  if (!('manifestLength' in header)) throw new Error('expected folder');
  const plain = Buffer.concat(chunks),
    manifest = decodeManifest(plain.subarray(0, header.manifestLength), header);
  const expected = new Map([
    ['secret-entry.md', 'hello'],
    ['private-data.txt', 'stored'],
  ]);
  assert.equal(manifest.entries.length, expected.size);
  for (const entry of manifest.entries)
    assert.equal(
      plain.subarray(entry.offset, entry.offset + entry.length).toString(),
      expected.get(entry.path)
    );
  await writeFile(file, zip([{ name: 'secret-entry.md', body: 'updated' }]));
  const next = await republishPrivate(
    { relic_id: first.relic_id, path: file },
    deps
  );
  assert.equal(next.shape, 'folder');
  const nextState = await loadPrivatePublishState(first.relic_id),
    nextBytes = await storage.read(lastObjectKey);
  assert.ok(nextState && nextBytes);
  assert.notEqual(nextState.version_keys['1'], nextState.version_keys['2']);
  assert.equal(
    (
      await openAnyRelic(nextBytes, decodeKey(nextState.version_keys['2']!), {
        admitted: [1, 2],
      })
    ).envelope.version,
    2
  );
  await assert.rejects(
    openAnyRelic(nextBytes, decodeKey(nextState.version_keys['1']!), {
      admitted: [1, 2],
    })
  );
  const opaquePath = join(tmp, 'opaque.zip');
  await writeFile(opaquePath, original);
  const opaqueResponse = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'relic_publish',
        arguments: { path: opaquePath, private: true, expand: false },
      },
    },
    deps
  );
  assert.ok(opaqueResponse?.result);
  const opaqueResult = opaqueResponse.result as {
    isError: boolean;
    structuredContent: PrivatePublishResult;
  };
  assert.equal(opaqueResult.isError, false);
  const opaque = opaqueResult.structuredContent;
  assert.equal(opaque.shape, 'file');
  assert.equal(opaque.renderer_class, 'archive');
  const opaqueState = await loadPrivatePublishState(opaque.relic_id),
    opaqueBytes = await storage.read(opaque.relic_id);
  assert.ok(opaqueState && opaqueBytes);
  const opened = await openAnyRelic(
    opaqueBytes,
    decodeKey(opaqueState.version_keys['1']!),
    { admitted: [1, 2] }
  );
  assert.equal(opened.envelope.version, 1);
  assert.deepEqual(Buffer.from(opened.content), original);
  await writeFile(
    opaquePath,
    zip([{ name: 'secret-entry.md', body: 'changed' }])
  );
  const opaqueNext = await republishPrivate(
    { relic_id: opaque.relic_id, path: opaquePath },
    deps
  );
  assert.equal(opaqueNext.shape, 'file');
  assert.equal(opaqueNext.renderer_class, 'archive');
  const fixtures: [string, Buffer, string][] = [
    ['traversal', zip([{ name: '../bad' }]), 'zip_unsafe_name'],
    ['absolute', zip([{ name: '/bad' }]), 'zip_unsafe_name'],
    ['encrypted', zip([{ name: 'bad', encrypted: true }]), 'zip_encrypted'],
    ['zip64', zip([], true), 'zip_unsupported'],
    [
      'bomb',
      zip([{ name: 'bomb', size: 524288001, deflate: true }]),
      'zip_expands_too_large',
    ],
    ['case', zip([{ name: 'A' }, { name: 'a' }]), 'path_collision'],
    ['encoding', zip([{ name: Buffer.from([0xff]) }]), 'zip_name_not_utf8'],
    [
      'count',
      zip(Array.from({ length: 5001 }, (_, i) => ({ name: `f${i}` }))),
      'too_many_files',
    ],
    ['refused-name', zip([{ name: 'bad\u202ename' }]), 'zip_unsafe_name'],
  ];
  for (const [name, bytes, code] of fixtures) {
    const path = join(tmp, `${name}.zip`);
    await writeFile(path, bytes);
    const before = requests.length;
    await assert.rejects(
      publishPrivate({ path }, deps),
      (error: unknown) =>
        error instanceof PublishError &&
        error.code === code &&
        error.message.includes('expand: false')
    );
    assert.equal(requests.length, before, name);
    await assert.rejects(
      republishPrivate({ relic_id: first.relic_id, path }, deps),
      (error: unknown) =>
        error instanceof PublishError &&
        error.code === code &&
        error.message.includes('expand: false')
    );
    assert.equal(requests.length, before, name);
  }
  for (const request of requests)
    for (const name of [
      'secret-entry.md',
      'private-data.txt',
      '__MACOSX',
      'private-link',
    ])
      assert.ok(!request.includes(name));
  console.log('MULTI_FILE_STAGE private-zip OK');
} finally {
  if (previousDevice === undefined) delete process.env.RELIC_DEVICE_KEYS;
  else process.env.RELIC_DEVICE_KEYS = previousDevice;
  if (previousState === undefined) delete process.env.RELIC_PUBLISH_STATE;
  else process.env.RELIC_PUBLISH_STATE = previousState;
  await rm(tmp, { recursive: true, force: true });
}
