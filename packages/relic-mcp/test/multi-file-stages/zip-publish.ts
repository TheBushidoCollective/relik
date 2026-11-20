import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import {
  crc32,
  decodeManifest,
  parseFragment,
  streamFolderContent,
  openAnyRelic,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../../src/files.ts';
import { publish, PublishError, type PublishDeps } from '../../src/publish.ts';
import { republish } from '../../src/republish.ts';

type Entry = {
  name: string | Buffer;
  body?: string;
  deflate?: boolean;
  symlink?: boolean;
  encrypted?: boolean;
  size?: number;
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
const tmp = await mkdtemp(join(tmpdir(), 'relic-zip-path-'));
const previous = process.env.RELIC_PUBLISH_STATE;
process.env.RELIC_PUBLISH_STATE = join(tmp, 'state.json');
try {
  const storage = new MemoryStorage(),
    app = createApp({ store: new MemoryStore(), storage });
  const origin = 'https://relic.example',
    calls: string[] = [];
  let uploaded: Uint8Array = new Uint8Array();
  const deps: PublishDeps = {
    serviceOrigin: origin,
    relicOrigin: origin,
    files: nodeFiles,
    clientName: 'zip-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test',
    }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.origin === origin) {
        const headers = new Headers(init?.headers);
        headers.set('x-forwarded-for', '198.51.100.11');
        return app.fetch(new Request(url, { ...init, headers }));
      }
      if (
        url.hostname === 'storage.invalid' &&
        url.pathname.startsWith('/o/')
      ) {
        const data = await storage.read(url.pathname.slice(3));
        return data
          ? new Response(data as unknown as BodyInit)
          : new Response(null, { status: 404 });
      }
      throw new Error('unexpected request');
    }) as typeof globalThis.fetch,
    upload: async (url, _headers, bytes) => {
      calls.push('PUT');
      uploaded = bytes;
      storage.put(new URL(url).pathname.replace(/^\/upload\//, ''), bytes);
      return { status: 200 };
    },
  };
  const file = join(tmp, 'sample.zip');
  const original = zip([
    { name: './README.md', body: 'hello', deflate: true },
    { name: 'data.txt', body: 'stored' },
    { name: '__MACOSX/._x', body: 'metadata' },
    { name: 'link', body: 'target', symlink: true },
  ]);
  await writeFile(file, original);
  const result = await publish({ path: file, cover: false }, deps);
  assert.equal(result.shape, 'folder');
  assert.equal(result.folder?.source, 'zip');
  assert.deepEqual(result.folder?.left_out.by_reason, {
    os_metadata: 1,
    symlink: 1,
  });
  const key = parseFragment(new URL(result.url).hash)!.key;
  const chunks: Uint8Array[] = [];
  const header = await streamFolderContent(
    new Blob([uploaded as unknown as BlobPart]).stream(),
    key,
    {
      objectLength: uploaded.length,
      onContent: (chunk) => {
        chunks.push(chunk);
      },
    }
  );
  const content = Buffer.concat(chunks),
    manifest = decodeManifest(
      content.subarray(0, header.manifestLength),
      header
    );
  const expected = new Map([
    ['README.md', 'hello'],
    ['data.txt', 'stored'],
  ]);
  for (const entry of manifest.entries)
    assert.equal(
      content.subarray(entry.offset, entry.offset + entry.length).toString(),
      expected.get(entry.path)
    );
  assert.equal(manifest.entries.length, 2);
  await writeFile(file, zip([{ name: 'README.md', body: 'updated' }]));
  const updatedFolder = await republish(
    { relic_id: result.relic_id, path: file, cover: false, notify: false },
    deps
  );
  assert.equal(updatedFolder.shape, 'folder');
  assert.equal(updatedFolder.folder?.source, 'zip');
  const docxPath = join(tmp, 'document.docx');
  await writeFile(docxPath, original);
  const docx = await publish({ path: docxPath, cover: false }, deps);
  assert.equal(docx.shape, 'file');
  const opaquePath = join(tmp, 'opaque.zip');
  await writeFile(opaquePath, original);
  const opaque = await publish(
    { path: opaquePath, cover: false, expand: false },
    deps
  );
  assert.equal(opaque.shape, 'file');
  assert.equal(opaque.renderer_class, 'archive');
  const opened = await openAnyRelic(
    uploaded,
    parseFragment(new URL(opaque.url).hash)!.key,
    { admitted: [1, 2] }
  );
  assert.equal(opened.envelope.version, 1);
  assert.deepEqual(Buffer.from(opened.content), original);
  await writeFile(
    opaquePath,
    zip([{ name: 'different.txt', body: 'changed' }])
  );
  const updated = await republish(
    {
      relic_id: opaque.relic_id,
      path: opaquePath,
      cover: false,
      notify: false,
    },
    deps
  );
  assert.equal(updated.shape, 'file');
  assert.equal(updated.renderer_class, 'archive');
  const corrupted = zip([{ name: 'crc', body: 'a' }]);
  corrupted[33] = corrupted[33]! ^ 1;
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
    ['duplicate', zip([{ name: 'x' }, { name: 'x' }]), 'zip_duplicate'],
    [
      'normalized-duplicate',
      zip([{ name: 'a//b' }, { name: 'a/b' }]),
      'zip_duplicate',
    ],
    ['file-directory', zip([{ name: 'a' }, { name: 'a/b' }]), 'path_collision'],
    ['crc', corrupted, 'zip_corrupt'],
  ];
  for (const [name, bytes, code] of fixtures) {
    const path = join(tmp, `${name}.zip`);
    await writeFile(path, bytes);
    const before = calls.length;
    await assert.rejects(
      publish({ path, cover: false }, deps),
      (error: unknown) =>
        error instanceof PublishError &&
        error.code === code &&
        error.message.includes('expand: false')
    );
    assert.equal(calls.length, before, name);
  }
  console.log('MULTI_FILE_STAGE zip-publish OK');
} finally {
  if (previous === undefined) delete process.env.RELIC_PUBLISH_STATE;
  else process.env.RELIC_PUBLISH_STATE = previous;
  await rm(tmp, { recursive: true, force: true });
}
