import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createApp } from '../packages/relic-server/src/app.ts';
import { ciphertextStorage, execute, inventory, invokeDelete, metadataBoundary, operatorApp, StorageClient, validateManifest, validateRun } from './ephemeral-operator.ts';

const sha = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
const enc = new TextEncoder();
type Item = { data: Uint8Array; generation: string };
class FakeGcs {
  data = new Map<string, Item>(); next = 1000; writes = 0; forcedStatus = 0; failDelete = false; malformedList = false; failSecondRow = false; rowWrites = 0; rowReads = 0; streamFailureOnRowRead = 0; streamFailureName = ''; calls: Array<{ method: string; name: string }> = [];
  add(name: string, data: string) { const generation = String(++this.next); this.data.set(name, { data: enc.encode(data), generation }); return generation; }
  fetch: typeof fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== 'https://storage.googleapis.com' || new Headers(init.headers).get('authorization') !== 'Bearer fake-cloud-token') return new Response('', { status: 403 });
    if (this.forcedStatus) return new Response('', { status: this.forcedStatus });
    const method = init.method ?? 'GET';
    this.calls.push({ method, name: url.searchParams.get('name') ?? decodeURIComponent(url.pathname.split('/o/')[1] ?? '') });
    const root = '/storage/v1/b/fake-bucket/o'; const upload = '/upload/storage/v1/b/fake-bucket/o';
    if (method === 'GET' && url.pathname === root) {
      if (this.malformedList) return Response.json({});
      const prefix = url.searchParams.get('prefix') ?? ''; const offset = Number(url.searchParams.get('pageToken') ?? '0');
      const matches = [...this.data].filter(([name]) => name.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b));
      const items = matches.slice(offset, offset + 2).map(([name, item]) => ({ name, generation: item.generation }));
      return Response.json({ kind: 'storage#objects', items, ...(offset + 2 < matches.length ? { nextPageToken: String(offset + 2) } : {}) });
    }
    if (method === 'POST' && url.pathname === upload) {
      const name = url.searchParams.get('name') ?? ''; const before = this.data.get(name); const expected = url.searchParams.get('ifGenerationMatch');
      if (name.startsWith('m/relic/') && ++this.rowWrites === 2 && this.failSecondRow) return new Response('', { status: 412 });
      if (expected !== (before?.generation ?? '0')) return new Response('', { status: 412 });
      this.writes++; const generation = this.add(name, String(init.body)); return Response.json({ generation });
    }
    if (url.pathname.startsWith(root + '/')) {
      const name = decodeURIComponent(url.pathname.slice(root.length + 1)); const item = this.data.get(name);
      if (!item) return new Response('', { status: 404 });
      if (method === 'GET') {
        if (name === this.streamFailureName && ++this.rowReads === this.streamFailureOnRowRead) {
          return new Response(new ReadableStream({ start(controller) { controller.error(new Error('fake stream failure')); } }), { status: 200, headers: { 'x-goog-generation': item.generation } });
        }
        return new Response(item.data, { headers: { 'x-goog-generation': item.generation } });
      }
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
    f.fake.malformedList = true; await expect(inventory(f.client, manifest)).rejects.toThrow(); f.fake.malformedList = false;
    const key = 'r/' + f.targets[0]!.id + '/v2'; const old = f.fake.data.get(key)!;
    f.fake.data.delete(key); await expect(inventory(f.client, manifest)).rejects.toThrow();
    f.fake.data.set(key, { ...old, generation: '999999' }); await expect(inventory(f.client, manifest)).rejects.toThrow();
    f.fake.data.set(key, old); f.fake.add('r/' + f.targets[0]!.id + '/v999', 'extra');
    await expect(inventory(f.client, manifest)).rejects.toThrow(); expect(f.fake.writes).toBe(0);
  });
  test('preexisting tombstone or wrong digest aborts every write', async () => {
    const f = fixture(); const manifest = validateManifest({ targets: f.targets }, f.hashes);
    const id = f.targets[0]!.id; f.fake.add('m/tomb/' + id + '.json', '{}');
    await expect(inventory(f.client, manifest)).rejects.toThrow();
    f.fake.data.delete('m/tomb/' + id + '.json');
    const key = 'r/' + id; const previous = f.fake.data.get(key)!;
    f.fake.data.set(key, { ...previous, data: enc.encode('changed bytes') });
    await expect(inventory(f.client, manifest)).rejects.toThrow();
    expect(f.fake.writes).toBe(0);
  });
  test('validates run and refuses wrong SHA, ref, repository and secret name', () => {
    const sha = 'a'.repeat(40);
    const env = { REVIEWED_SHA: sha, GITHUB_SHA: sha, WORKFLOW_SHA: sha, REPOSITORY_ID: '1316636189', EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/archie/ephemeral-operator-maintenance', WORKFLOW_REF: 'TheBushidoCollective/relik/.github/workflows/deploy.yml@refs/heads/archie/ephemeral-operator-maintenance', RUN_ATTEMPT: '1', ACTOR: 'jwaldrip', ACTOR_ID: '43164', TRIGGERING_ACTOR: 'jwaldrip', ACTION: 'delete-five', MANIFEST_SECRET_NAME: 'RELIC_MAINTENANCE_' + 'A'.repeat(32), RUN_ID: '123' };
    expect(() => validateRun(env)).not.toThrow();
    for (const patch of [{ GITHUB_SHA: 'b'.repeat(40) }, { GITHUB_REF: 'refs/heads/main' }, { REPOSITORY_ID: '1' }, { MANIFEST_SECRET_NAME: 'RELIC_OPERATOR_TOKENS' }, { RUN_ATTEMPT: '2' }, { ACTOR: 'other' }, { ACTOR_ID: '999' }, { TRIGGERING_ACTOR: 'other' }, { ACTION: 'other' }]) expect(() => validateRun({ ...env, ...patch })).toThrow();
  });
  test('ciphertext adapter refuses changed current generations', async () => {
    const f = fixture(); const snap = await inventory(f.client, validateManifest({ targets: f.targets }, f.hashes));
    const target = f.targets[0]!; const name = 'r/' + target.id;
    f.fake.data.set(name, { ...f.fake.data.get(name)!, generation: '999999' });
    await expect(ciphertextStorage(f.client, snap).read(target.id)).rejects.toThrow();
    await expect(ciphertextStorage(f.client, snap).delete(target.id)).rejects.toThrow();
    expect(f.fake.writes).toBe(0);
  });
  test('authorized active target cannot read or delete an existing non-target row', async () => {
    const f = fixture(); const snap = await inventory(f.client, validateManifest({ targets: f.targets }, f.hashes));
    const active = f.targets[0]!.id; const other = f.targets[1]!.id;
    const name = 'm/relic/' + other + '.json'; const original = f.fake.data.get(name)!; const calls = f.fake.calls.length;
    const url = 'https://storage.googleapis.com/storage/v1/b/fake-bucket/o/' + encodeURIComponent(name);
    const headers = { authorization: 'Bearer fake-cloud-token' };
    await expect(metadataBoundary(f.client, snap, () => active, 'fake').fetch(url + '?alt=media', { headers })).rejects.toThrow();
    await expect(metadataBoundary(f.client, snap, () => active, 'fake').fetch(url, { method: 'DELETE', headers })).rejects.toThrow();
    expect(f.fake.calls.length).toBe(calls); expect(f.fake.writes).toBe(0); expect(f.fake.data.get(name)).toEqual(original);
  });
  test('duplicate upload names and deletion of the active row never reach storage', async () => {
    const f = fixture(); const snap = await inventory(f.client, validateManifest({ targets: f.targets }, f.hashes));
    const id = f.targets[0]!.id; const tomb = 'm/tomb/' + id + '.json'; const row = 'm/relic/' + id + '.json'; const calls = f.fake.calls.length;
    const base = 'https://storage.googleapis.com'; const headers = { authorization: 'Bearer fake-cloud-token' };
    const query = '?uploadType=media&name=' + encodeURIComponent(tomb) + '&name=' + encodeURIComponent(tomb);
    const body = JSON.stringify({ id, operator: 'fake', reasonClass: 'operator_error', ciphertextHash: 'a'.repeat(64) });
    await expect(metadataBoundary(f.client, snap, () => id, 'fake').fetch(base + '/upload/storage/v1/b/fake-bucket/o' + query, { method: 'POST', headers, body })).rejects.toThrow();
    await expect(metadataBoundary(f.client, snap, () => id, 'fake').fetch(base + '/storage/v1/b/fake-bucket/o/' + encodeURIComponent(row), { method: 'DELETE', headers })).rejects.toThrow();
    expect(f.fake.calls.length).toBe(calls); expect(f.fake.writes).toBe(0); expect(f.fake.data.has(row)).toBe(true); expect(f.fake.data.has(tomb)).toBe(false);
  });
  test('a corrupt fifth target stops execute after all five row reads but before every write', async () => {
    const f = fixture(); const last = f.targets[4]!; const key = 'r/' + last.id; const original = f.fake.data.get(key)!;
    f.fake.data.set(key, { ...original, data: enc.encode('mismatched bytes') }); process.env.RUN_ID = '123';
    try { await expect(execute(f.client, { targets: f.targets }, f.hashes)).rejects.toThrow(); }
    finally { delete process.env.RUN_ID; }
    const reads = f.fake.calls.filter(call => call.method === 'GET').map(call => call.name);
    const rowPositions = f.targets.map(target => reads.indexOf('m/relic/' + target.id + '.json'));
    expect(rowPositions.every(position => position >= 0)).toBe(true);
    expect(rowPositions).toEqual([...rowPositions].sort((a, b) => a - b));
    expect(f.fake.calls.every(call => call.method === 'GET')).toBe(true); expect(f.fake.writes).toBe(0);
    for (const target of f.targets) expect(f.fake.data.has('m/tomb/' + target.id + '.json')).toBe(false);
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
  test('metadata read rejects same-generation bytes that differ from inventory', async () => {
    const f = fixture(); const snap = await inventory(f.client, validateManifest({ targets: f.targets }, f.hashes));
    const id = f.targets[0]!.id; const name = 'm/relic/' + id + '.json'; const item = f.fake.data.get(name)!;
    f.fake.data.set(name, { ...item, data: enc.encode('{}') });
    const guarded = metadataBoundary(f.client, snap, () => id, 'fake');
    await expect(guarded.fetch('https://storage.googleapis.com/storage/v1/b/fake-bucket/o/' + encodeURIComponent(name) + '?alt=media', { headers: { authorization: 'Bearer fake-cloud-token' } })).rejects.toThrow();
    expect(guarded.faulted()).toBe(true); expect(f.fake.writes).toBe(0);
  });
  test('share-row stream failure latches before opt-out and decision sweeps', async () => {
    const f = fixture(); const target = f.targets[0]!; const row = 'm/relic/' + target.id + '.json'; const item = f.fake.data.get(row)!;
    f.fake.data.set(row, { ...item, data: enc.encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(item.data)), sharesCount: 0 })) });
    const optout = 'm/optout/' + target.id + '/entry.json'; const decision = 'm/decision/' + target.id + '/entry.json';
    f.fake.add(optout, '{}'); f.fake.add(decision, '{}'); f.fake.streamFailureName = row; f.fake.streamFailureOnRowRead = 4;
    const output: string[] = []; const log = console.log; const error = console.error;
    console.log = (...v) => { output.push(v.join(' ')); }; console.error = (...v) => { output.push(v.join(' ')); }; process.env.RUN_ID = '123';
    try { await expect(execute(f.client, { targets: f.targets }, f.hashes)).rejects.toThrow(); }
    finally { console.log = log; console.error = error; delete process.env.RUN_ID; }
    expect(f.fake.rowReads).toBe(4); expect(f.fake.data.has(optout)).toBe(true); expect(f.fake.data.has(decision)).toBe(true);
    expect(output.join('\n')).not.toContain('handler and immediate readback completed');
    expect(f.fake.data.has('m/tomb/' + f.targets[1]!.id + '.json')).toBe(false);
  });
  test('a caught row CAS failure latches the boundary before later sweeps', async () => {
    const f = fixture(); const target = f.targets[0]!; const optout = 'm/optout/' + target.id + '/entry.json';
    f.fake.add(optout, '{}'); f.fake.failSecondRow = true; process.env.RUN_ID = '123';
    try { await expect(execute(f.client, { targets: f.targets }, f.hashes)).rejects.toThrow(); }
    finally { delete process.env.RUN_ID; }
    expect(f.fake.data.has(optout)).toBe(true);
    expect(f.fake.data.has('m/tomb/' + f.targets[1]!.id + '.json')).toBe(false);
  });
  test('precondition failure stops after tombstone, without touching another target', async () => {
    const f = fixture(); f.fake.failDelete = true; process.env.RUN_ID = '123';
    try { await expect(execute(f.client, { targets: f.targets }, f.hashes)).rejects.toThrow(); }
    finally { delete process.env.RUN_ID; }
    expect(f.fake.data.has('m/tomb/' + f.targets[0]!.id + '.json')).toBe(true);
    expect(f.fake.data.has('m/tomb/' + f.targets[1]!.id + '.json')).toBe(false);
  });
});
