import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createApp } from '../packages/relic-server/src/app.ts';
import { execute, inventory, invokeDelete, metadataBoundary, operatorApp, StorageClient, validateManifest } from './ephemeral-operator.ts';

const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const enc = new TextEncoder();
type Item = { data: Uint8Array; generation: string };
class FakeGcs {
  data = new Map<string, Item>(); next = 1000; writes = 0; forcedStatus = 0; failDelete = false;
  add(name: string, data: string) { const generation = String(++this.next); this.data.set(name, { data: enc.encode(data), generation }); return generation; }
  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://storage.googleapis.com' || new Headers(init.headers).get('authorization') !== 'Bearer fake-cloud-token') return new Response('', { status: 403 });
    if (this.forcedStatus) return new Response('', { status: this.forcedStatus });
    const method = init.method ?? 'GET'; const root = '/storage/v1/b/fake-bucket/o'; const upload = '/upload/storage/v1/b/fake-bucket/o';
    if (method === 'GET' && url.pathname === root) {
      const prefix = url.searchParams.get('prefix') ?? ''; const offset = Number(url.searchParams.get('pageToken') ?? '0');
      const matches = [...this.data].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const items = matches.slice(offset, offset + 2).map(([name, item]) => ({ name, generation: item.generation }));
      return Response.json({ items, ...(offset + 2 < matches.length ? { nextPageToken: String(offset + 2) } : {}) });
    }
    if (method === 'POST' && url.pathname === upload) {
      const name = url.searchParams.get('name') ?? ''; const before = this.data.get(name); const expected = url.searchParams.get('ifGenerationMatch');
      if (expected !== (before?.generation ?? '0')) return new Response('', { status: 412 });
      this.writes++; const generation = this.add(name, String(init.body)); return Response.json({ generation });
    }
    if (url.pathname.startsWith(root + '/')) {
      const name = decodeURIComponent(url.pathname.slice(root.length + 1)); const item = this.data.get(name);
      if (!item) return new Response('', { status: 404 });
      if (method === 'GET') return new Response(item.data, { headers: { 'x-goog-generation': item.generation } });
      if (method === 'DELETE') {
        if (this.failDelete || url.searchParams.get('ifGenerationMatch') !== item.generation) return new Response('', { status: 412 });
        this.writes++; this.data.delete(name); return new Response(null, { status: 204 });
      }
    }
    return new Response('', { status: 403 });
  };
}
function fixture() {
  const fake = new FakeGcs();
  const counts = [3, 3, 3, 4, 4];
  const targets = counts.map((count, index) => {
    const id = String(index + 1).repeat(26); const rowGeneration = fake.add('m/relic/' + id + '.json', JSON.stringify({ id, version: count, publishIp: '127.0.0.1', publishedAt: 1, publishingClient: 'fake', rendererClass: 'html' }));
    const versions = Array.from({ length: count }, (_, i) => {
      const version = i + 1; const value = 'fake ciphertext ' + index + '/' + version; const key = 'r/' + id + (version === 1 ? '' : '/v' + version);
      return { version, generation: fake.add(key, value), sha256: sha(value) };
    });
    return { id, rowGeneration, versions };
  });
  const first = targets[0]!.id; const author = 'fake@example.invalid';
  fake.add('m/comment/' + first + '/c1.json', JSON.stringify({ id: 'c1', relicId: first, author, createdAt: 1, ciphertext: 'fake' }));
  fake.add('m/author_relic/' + sha(author) + '/' + first + '.json', '{}');
  fake.add('m/commenter/' + first + '/entry.json', '{}');
  return { fake, targets, hashes: targets.map(t => sha(t.id)), client: new StorageClient('fake-bucket', 'fake-cloud-token', fake.fetch) };
}

describe('ephemeral operator controls', () => {
  test('accepts exactly the authorized canonical five and rejects a sixth or changed target', () => {
    const f = fixture(); expect(validateManifest({ targets: f.targets }, f.hashes).targets).toHaveLength(5);
    expect(() => validateManifest({ targets: [...f.targets, f.targets[0]] }, f.hashes)).toThrow();
    const changed = structuredClone(f.targets); changed[0]!.id = '9'.repeat(26);
    expect(() => validateManifest({ targets: changed }, f.hashes)).toThrow();
    const alias = structuredClone(f.targets); alias[0]!.id = 'I'.repeat(26);
    expect(() => validateManifest({ targets: alias }, f.hashes)).toThrow();
  });
  test('rejects malformed and missing generations and digest', () => {
    const f = fixture(); const altered = structuredClone(f.targets); altered[0]!.versions[0]!.sha256 = '';
    expect(() => validateManifest({ targets: altered }, f.hashes)).toThrow();
    altered[0]!.versions[0]!.sha256 = 'a'.repeat(64); altered[0]!.rowGeneration = '0';
    expect(() => validateManifest({ targets: altered }, f.hashes)).toThrow();
  });
  test('inventory follows pages and rejects missing, permission errors, unexpected versions and replacement', async () => {
    const f = fixture(); const manifest = validateManifest({ targets: f.targets }, f.hashes);
    await inventory(f.client, manifest);
    f.fake.forcedStatus = 403; await expect(inventory(f.client, manifest)).rejects.toThrow(); f.fake.forcedStatus = 0;
    const key = 'r/' + f.targets[0]!.id + '/v2'; const old = f.fake.data.get(key)!;
    f.fake.data.delete(key); await expect(inventory(f.client, manifest)).rejects.toThrow();
    f.fake.data.set(key, { ...old, generation: '999999' }); await expect(inventory(f.client, manifest)).rejects.toThrow();
    f.fake.data.set(key, old); f.fake.add('r/' + f.targets[0]!.id + '/v999', 'extra');
    await expect(inventory(f.client, manifest)).rejects.toThrow(); expect(f.fake.writes).toBe(0);
  });
  test('metadata transport refuses a sixth target before writes', async () => {
    const f = fixture(); const snap = await inventory(f.client, validateManifest({ targets: f.targets }, f.hashes));
    const guarded = metadataBoundary(f.client, snap, () => '9'.repeat(26), 'fake');
    await expect(guarded.fetch('https://storage.googleapis.com/storage/v1/b/fake-bucket/o/m%2Frelic%2F' + '9'.repeat(26) + '.json?alt=media', { headers: { authorization: 'Bearer fake-cloud-token' } })).rejects.toThrow();
    expect(f.fake.writes).toBe(0);
  });
  test('requires adapters, rejects sixth target and wrong bearer without writes', async () => {
    expect(() => operatorApp(undefined, undefined, new Map())).toThrow();
    const app = createApp({ operatorTokens: new Map([['fake', 'right']]) });
    const id = '1'.repeat(26); const allowed = new Set([id]);
    await expect(invokeDelete(app, allowed, '2'.repeat(26), 'right')).rejects.toThrow();
    expect((await invokeDelete(app, allowed, id, 'wrong')).status).toBe(401);
  });
  test('fake GCS full handler only touches the authorized set and does not print secrets', async () => {
    const f = fixture(); f.fake.add('r/' + '9'.repeat(26), 'non-target');
    const oldLog = console.log; const oldError = console.error; const output: string[] = [];
    console.log = (...v) => { output.push(v.join(' ')); }; console.error = (...v) => { output.push(v.join(' ')); };
    process.env.RUN_ID = '123';
    try { await execute(f.client, { targets: f.targets }, f.hashes, () => 'X'.repeat(43)); }
    finally { console.log = oldLog; console.error = oldError; delete process.env.RUN_ID; }
    expect(f.fake.data.has('r/' + '9'.repeat(26))).toBe(true);
    expect(output.join('\n')).not.toContain('fake-cloud-token');
    expect(output.join('\n')).not.toContain('X'.repeat(43));
    for (const target of f.targets) { expect(f.fake.data.has('m/tomb/' + target.id + '.json')).toBe(true); expect(f.fake.data.has('r/' + target.id)).toBe(false); expect(output.join('\n')).not.toContain(target.id); }
  });
  test('precondition failure stops after tombstone, without touching another target', async () => {
    const f = fixture(); f.fake.failDelete = true; process.env.RUN_ID = '123';
    try { await expect(execute(f.client, { targets: f.targets }, f.hashes)).rejects.toThrow(); }
    finally { delete process.env.RUN_ID; }
    expect(f.fake.data.has('m/tomb/' + f.targets[0]!.id + '.json')).toBe(true);
    expect(f.fake.data.has('m/tomb/' + f.targets[1]!.id + '.json')).toBe(false);
  });
});
