import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../packages/relic-server/src/app.ts';
import { gcsStore } from '../packages/relic-server/src/gcsstore.ts';
import type { ObjectStorage } from '../packages/relic-server/src/storage.ts';
import type { RelicStore } from '../packages/relic-server/src/store.ts';

const AUTHORIZED = [
  '086b6758b80cf43ee521d761ae3769914539a61424d4ebbf6947610f0dae0ebd',
  '1fabccb0e6646824d5a92f689b9bc95fbeaed30f8494ef90fb6670b6a549e4e2',
  '910fc38382ff6d25131449320f8632298402ad3b73e0c31631ed82c175ab3c69',
  '95724bae6cd9a4b87dcc4d6180177b4f97ad08db9f83bd77735864b72b27a170',
  'ea69c1a78b030765b830d65242ada905318a2a5f559dbe1505a4d951e58a7364',
];
type Version = { version: number; generation: string; sha256: string };
type Target = { id: string; rowGeneration: string; versions: Version[] };
type Manifest = { targets: Target[] };
const digest = (input: Uint8Array | string) => createHash('sha256').update(input).digest('hex');
const generation = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]*$/.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function fields(v: Record<string, unknown>, names: string[]): boolean {
  return Object.keys(v).sort().join(',') === names.sort().join(',');
}

export function validateManifest(value: unknown, hashes: readonly string[] = AUTHORIZED): Manifest {
  if (!object(value) || !fields(value, ['targets']) || !Array.isArray(value.targets) || value.targets.length !== 5) throw Error('manifest shape');
  const targets: Target[] = [];
  for (const item of value.targets) {
    if (!object(item) || !fields(item, ['id', 'rowGeneration', 'versions']) || typeof item.id !== 'string' || !/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(item.id) || !generation(item.rowGeneration) || !Array.isArray(item.versions) || item.versions.length === 0) throw Error('target shape');
    const versions: Version[] = [];
    for (const [i, version] of item.versions.entries()) {
      if (!object(version) || !fields(version, ['version', 'generation', 'sha256']) || version.version !== i + 1 || !generation(version.generation) || !hex(version.sha256)) throw Error('version shape');
      versions.push({ version: i + 1, generation: version.generation, sha256: version.sha256 });
    }
    targets.push({ id: item.id, rowGeneration: item.rowGeneration, versions });
  }
  if (new Set(targets.map(t => t.id)).size !== 5 || targets.reduce((n, t) => n + t.versions.length, 0) !== 17 || targets.map(t => digest(t.id)).sort().join(',') !== [...hashes].sort().join(',')) throw Error('manifest authorization');
  return { targets };
}

function fail(message: string): never { throw Error(message); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
const bytes = async (response: Response): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer());

export class StorageClient {
  constructor(readonly bucket: string, readonly token: string, readonly transport: typeof fetch = fetch) {
    if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(bucket) || !token) fail('storage configuration');
  }
  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    headers.set('authorization', 'Bearer ' + this.token);
    try { return await this.transport('https://storage.googleapis.com' + path, { ...options, headers, redirect: 'error' }); }
    catch { return fail('storage transport'); }
  }
  private url(name: string): string { return '/storage/v1/b/' + encodeURIComponent(this.bucket) + '/o/' + encodeURIComponent(name); }
  async read(name: string): Promise<{ data: Uint8Array; generation: string } | undefined> {
    const r = await this.request(this.url(name) + '?alt=media');
    if (r.status === 404) return undefined;
    if (!r.ok) fail('storage read');
    const g = r.headers.get('x-goog-generation');
    if (!generation(g)) fail('storage generation');
    return { data: await bytes(r), generation: g };
  }
  async list(prefix: string): Promise<Map<string, string>> {
    const result = new Map<string, string>(); let token: string | undefined; const seen = new Set<string>();
    do {
      const p = new URLSearchParams({ prefix }); if (token) p.set('pageToken', token);
      const r = await this.request('/storage/v1/b/' + encodeURIComponent(this.bucket) + '/o?' + p);
      if (!r.ok) fail('storage list');
      const page: unknown = await r.json();
      if (!object(page) || (page.items !== undefined && !Array.isArray(page.items)) || (page.nextPageToken !== undefined && (typeof page.nextPageToken !== 'string' || !page.nextPageToken))) fail('list shape');
      for (const item of (page.items ?? []) as unknown[]) {
        if (!object(item) || typeof item.name !== 'string' || !item.name.startsWith(prefix) || !generation(item.generation) || result.has(item.name)) fail('list item');
        result.set(item.name, item.generation);
      }
      token = page.nextPageToken as string | undefined;
      if (token && seen.has(token)) fail('pagination cycle'); if (token) seen.add(token);
    } while (token);
    return result;
  }
  async remove(name: string, expected: string): Promise<void> {
    if (!generation(expected)) fail('delete precondition');
    const r = await this.request(this.url(name) + '?ifGenerationMatch=' + expected, { method: 'DELETE' });
    if (!r.ok) fail('storage delete');
  }
}


type Snapshot = { objects: Map<string, string>; rows: Map<string, Record<string, unknown>>; bodies: Map<string, Uint8Array> };
const metadataPrefixes = ['cover', 'comment', 'commenter', 'share', 'optout', 'decision'];
const rowKey = (id: string) => 'm/relic/' + id + '.json';
const tombKey = (id: string) => 'm/tomb/' + id + '.json';
const cipherKey = (id: string, version: number) => 'r/' + id + (version === 1 ? '' : '/v' + version);
const decodeJson = (data: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(data));

export async function inventory(client: StorageClient, manifest: Manifest): Promise<Snapshot> {
  const objects = new Map<string, string>(); const bodies = new Map<string, Uint8Array>(); const rows = new Map<string, Record<string, unknown>>();
  const expectedAuthors = new Set<string>(); const ids = new Set(manifest.targets.map(t => t.id));
  for (const target of manifest.targets) {
    const row = await client.read(rowKey(target.id));
    if (!row || row.generation !== target.rowGeneration) fail('row changed');
    const parsed = decodeJson(row.data);
    if (!object(parsed) || parsed.id !== target.id || parsed.version !== target.versions.length) fail('row invalid');
    if (await client.read(tombKey(target.id))) fail('tombstone already exists');
    objects.set(rowKey(target.id), row.generation); bodies.set(rowKey(target.id), row.data); rows.set(target.id, parsed);
    const nested = await client.list('r/' + target.id + '/');
    const expectedNested = new Set(target.versions.slice(1).map(v => cipherKey(target.id, v.version)));
    if (nested.size !== expectedNested.size || [...nested.keys()].some(k => !expectedNested.has(k))) fail('ciphertext inventory');
    for (const version of target.versions) {
      const name = cipherKey(target.id, version.version);
      if (version.version > 1 && nested.get(name) !== version.generation) fail('ciphertext generation');
      const data = await client.read(name);
      if (!data || data.generation !== version.generation || digest(data.data) !== version.sha256) fail('ciphertext mismatch');
      objects.set(name, data.generation);
    }
    for (const kind of metadataPrefixes) {
      const entries = await client.list('m/' + kind + '/' + target.id + '/');
      for (const [name, g] of entries) {
        const value = await client.read(name);
        if (!value || value.generation !== g) fail('metadata changed');
        objects.set(name, g); bodies.set(name, value.data);
        if (kind === 'comment') {
          const comment = decodeJson(value.data);
          const leaf = name.slice(('m/comment/' + target.id + '/').length);
          if (!object(comment) || typeof comment.id !== 'string' || leaf !== comment.id + '.json' || comment.relicId !== target.id || typeof comment.author !== 'string') fail('comment metadata');
          expectedAuthors.add('m/author_relic/' + digest(comment.author) + '/' + target.id + '.json');
        }
      }
    }
  }
  const authorEntries = await client.list('m/author_relic/');
  const actualAuthors = new Set<string>();
  for (const [name, g] of authorEntries) {
    const parts = name.split('/');
    const leaf = parts.at(-1) ?? '';
    const matched = leaf.endsWith('.json') && ids.has(leaf.slice(0, -5));
    if (!matched) continue;
    if (parts.length !== 4 || !hex(parts[2])) fail('author index name');
    const id = leaf.slice(0, -5); if (!ids.has(id)) fail('author index target');
    const value = await client.read(name);
    if (!value || value.generation !== g) fail('author index changed');
    actualAuthors.add(name); objects.set(name, g); bodies.set(name, value.data);
  }
  if (actualAuthors.size !== expectedAuthors.size || [...actualAuthors].some(k => !expectedAuthors.has(k))) fail('author index mismatch');
  return { objects, rows, bodies };
}

export function ciphertextStorage(client: StorageClient, snapshot: Snapshot): ObjectStorage {
  function resolve(key: string): [string, string] {
    const name = 'r/' + key; const expected = snapshot.objects.get(name);
    if (!expected) fail('unauthorized ciphertext');
    return [name, expected];
  }
  return {
    async read(key) {
      const [name, expected] = resolve(key); const item = await client.read(name);
      if (!item || item.generation !== expected) fail('ciphertext changed');
      return item.data;
    },
    async delete(key) {
      const [name, expected] = resolve(key); await client.remove(name, expected); snapshot.objects.delete(name);
    },
    async stat() { return fail('unsupported storage method'); },
    async digest() { return fail('unsupported storage method'); },
    async signUpload() { return fail('unsupported storage method'); },
    async signDownload() { return fail('unsupported storage method'); },
  };
}


export function metadataBoundary(client: StorageClient, snapshot: Snapshot, current: () => string, operator: string) {
  let faulted = false;
  const pages = new Map<string, { expected: Set<string>; seen: Set<string>; tokens: Set<string> }>();
  const call: typeof fetch = async (input, init = {}) => {
    try {
      const id = current(); if (!snapshot.rows.has(id)) fail('inactive target');
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init.method ?? 'GET').toUpperCase();
      const base = '/storage/v1/b/' + encodeURIComponent(client.bucket) + '/o';
      const upload = '/upload/storage/v1/b/' + encodeURIComponent(client.bucket) + '/o';
      if (url.origin !== 'https://storage.googleapis.com' || url.hash || url.username || url.password || new Headers(init.headers).get('authorization') !== 'Bearer ' + client.token) fail('metadata origin');
      for (const key of url.searchParams.keys()) if (url.searchParams.getAll(key).length !== 1) fail('metadata parameters');
      const allowed = new Set(['m/relic/' + id + '.json', 'm/tomb/' + id + '.json']);
      for (const key of snapshot.objects.keys()) {
        if (metadataPrefixes.some(kind => key.startsWith('m/' + kind + '/' + id + '/')) || /^m\/author_relic\/[a-f0-9]{64}\//.test(key) && key.endsWith('/' + id + '.json')) allowed.add(key);
      }
      if (method === 'GET' && url.pathname === base) {
        if ([...url.searchParams.keys()].some(k => !['prefix', 'pageToken'].includes(k))) fail('list parameters');
        const prefix = url.searchParams.get('prefix');
        if (!prefix || !metadataPrefixes.some(kind => prefix === 'm/' + kind + '/' + id + '/')) fail('list scope');
        const pageToken = url.searchParams.get('pageToken');
        if (!pageToken) pages.set(prefix, { expected: new Set([...snapshot.objects.keys()].filter(k => k.startsWith(prefix))), seen: new Set(), tokens: new Set() });
        const state = pages.get(prefix); if (!state || (pageToken && state.tokens.has(pageToken))) fail('pagination state');
        if (pageToken) state.tokens.add(pageToken);
        const response = await client.transport(url, { ...init, redirect: 'error' });
        if (!response.ok) fail('metadata list');
        const body: unknown = await response.clone().json();
        if (!object(body) || (body.items !== undefined && !Array.isArray(body.items)) || (body.nextPageToken !== undefined && (typeof body.nextPageToken !== 'string' || !body.nextPageToken))) fail('metadata page');
        for (const item of (body.items ?? []) as unknown[]) {
          if (!object(item) || typeof item.name !== 'string' || !state.expected.has(item.name) || state.seen.has(item.name) || item.generation !== snapshot.objects.get(item.name)) fail('metadata inventory mismatch');
          state.seen.add(item.name);
        }
        if (body.nextPageToken === undefined && state.seen.size !== state.expected.size) fail('metadata missing');
        return response;
      }
      if (url.pathname.startsWith(base + '/')) {
        const name = decodeURIComponent(url.pathname.slice(base.length + 1));
        if (!allowed.has(name)) fail('metadata scope');
        if (method === 'GET') {
          if (url.search !== '?alt=media') fail('metadata read parameters');
          const response = await client.transport(url, { ...init, redirect: 'error' });
          const expected = snapshot.objects.get(name);
          if (!expected) { if (name === tombKey(id) && response.status === 404) return response; fail('metadata absence'); }
          if (!response.ok || response.headers.get('x-goog-generation') !== expected) fail('metadata read changed');
          return response;
        }
        if (method === 'DELETE') {
          if (url.search) fail('metadata delete parameters');
          const expected = snapshot.objects.get(name); if (!expected || name === rowKey(id) || name === tombKey(id)) fail('metadata delete scope');
          url.searchParams.set('ifGenerationMatch', expected);
          const response = await client.transport(url, { ...init, redirect: 'error' });
          if (!response.ok) fail('metadata delete');
          snapshot.objects.delete(name); snapshot.bodies.delete(name); return response;
        }
      }
      if (method === 'POST' && url.pathname === upload) {
        if ([...url.searchParams.keys()].some(k => !['uploadType', 'name', 'ifGenerationMatch'].includes(k)) || url.searchParams.get('uploadType') !== 'media' || typeof init.body !== 'string') fail('metadata upload parameters');
        const name = url.searchParams.get('name'); if (name !== rowKey(id) && name !== tombKey(id)) fail('metadata upload scope');
        const next: unknown = JSON.parse(init.body); if (!object(next)) fail('metadata upload body');
        if (name === tombKey(id)) {
          if (snapshot.objects.has(name) || url.searchParams.has('ifGenerationMatch') || next.id !== id || next.operator !== operator || next.reasonClass !== 'operator_error' || next.reportReference !== undefined || !hex(next.ciphertextHash)) fail('tombstone scope');
          url.searchParams.set('ifGenerationMatch', '0');
        } else {
          const expected = snapshot.objects.get(name); const previousBytes = snapshot.bodies.get(name);
          if (!expected || !previousBytes || url.searchParams.get('ifGenerationMatch') !== expected) fail('metadata CAS');
          const previous = decodeJson(previousBytes); if (!object(previous)) fail('row shape');
          const a = { ...previous }, b = { ...next }; delete a.cover; delete b.cover; delete a.sharesCount; delete b.sharesCount;
          if (!same(a, b) || (next.cover !== undefined && !same(next.cover, previous.cover)) || (next.sharesCount !== previous.sharesCount && next.sharesCount !== 0)) fail('row update scope');
        }
        const response = await client.transport(url, { ...init, redirect: 'error' });
        if (!response.ok) fail('metadata write');
        const result: unknown = await response.clone().json();
        if (!object(result) || !generation(result.generation)) fail('metadata generation');
        snapshot.objects.set(name, result.generation); snapshot.bodies.set(name, new TextEncoder().encode(init.body));
        return response;
      }
      return fail('metadata method');
    } catch { faulted = true; return fail('metadata boundary refused'); }
  };
  return { fetch: call, faulted: () => faulted };
}


function required(name: string): string { const value = process.env[name]; if (!value) fail('missing environment'); return value; }
export function validateRun(env: Record<string, string | undefined>): void {
  const sha = env.REVIEWED_SHA;
  if (!sha || !/^[a-f0-9]{40}$/.test(sha) || env.GITHUB_SHA !== sha || env.WORKFLOW_SHA !== sha || env.REPOSITORY_ID !== '1316636189' || env.EVENT_NAME !== 'workflow_dispatch' || env.GITHUB_REF !== 'refs/heads/archie/ephemeral-operator-maintenance' || env.WORKFLOW_REF !== 'TheBushidoCollective/relik/.github/workflows/deploy.yml@refs/heads/archie/ephemeral-operator-maintenance' || env.RUN_ATTEMPT !== '1' || env.ACTION !== 'delete-five' || !/^RELIC_MAINTENANCE_[A-F0-9]{32}$/.test(env.MANIFEST_SECRET_NAME ?? '') || !/^[0-9]+$/.test(env.RUN_ID ?? '')) fail('run identity');
}

async function jsonResponse(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) fail('identity exchange'); const body: unknown = await response.json(); if (!object(body)) fail('identity response'); return body;
}
async function accessToken(): Promise<string> {
  const provider = required('WIF_PROVIDER'); const service = required('DEPLOYER_SA');
  if (provider !== 'projects/911514101920/locations/global/workloadIdentityPools/github/providers/artifacts' || service !== 'relic-deployer@thebushido-co.iam.gserviceaccount.com' || required('GCP_PROJECT_ID') !== 'thebushido-co') fail('identity target');
  const requestUrl = new URL(required('ACTIONS_ID_TOKEN_REQUEST_URL'));
  if (requestUrl.protocol !== 'https:' || requestUrl.username || requestUrl.password || requestUrl.hash) fail('identity URL');
  requestUrl.searchParams.set('audience', 'https://iam.googleapis.com/' + provider);
  const oidc = await jsonResponse(await fetch(requestUrl, { headers: { authorization: 'Bearer ' + required('ACTIONS_ID_TOKEN_REQUEST_TOKEN') }, redirect: 'error' }));
  if (typeof oidc.value !== 'string' || !oidc.value) fail('identity token');
  const federated = await jsonResponse(await fetch('https://sts.googleapis.com/v1/token', {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audience: '//iam.googleapis.com/' + provider, grantType: 'urn:ietf:params:oauth:grant-type:token-exchange', requestedTokenType: 'urn:ietf:params:oauth:token-type:access_token', subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt', subjectToken: oidc.value, scope: 'https://www.googleapis.com/auth/cloud-platform' }),
  }));
  if (typeof federated.access_token !== 'string' || !federated.access_token) fail('federated token');
  const impersonated = await jsonResponse(await fetch('https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' + encodeURIComponent(service) + ':generateAccessToken', {
    method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + federated.access_token, 'content-type': 'application/json' }, body: JSON.stringify({ scope: ['https://www.googleapis.com/auth/cloud-platform'] }),
  }));
  if (typeof impersonated.accessToken !== 'string' || !impersonated.accessToken) fail('impersonated token');
  return impersonated.accessToken;
}

export async function invokeDelete(app: ReturnType<typeof createApp>, allowed: ReadonlySet<string>, id: string, secret: string): Promise<Response> {
  if (!allowed.has(id) || !/^[0-9abcdefghjkmnpqrstvwxyz]{26}$/.test(id)) fail('target authorization');
  return app.fetch(new Request('https://maintenance.invalid/api/relics/' + id + '?reason=operator_error&blocklist=false', { method: 'DELETE', headers: { authorization: 'Bearer ' + secret } }));
}

export function operatorApp(store: RelicStore | undefined, storage: ObjectStorage | undefined, operators: ReadonlyMap<string, string>) {
  if (!store || !storage) fail('adapters required');
  return createApp({ store, storage, operatorTokens: operators });
}

export async function execute(client: StorageClient, input: Manifest, hashes: readonly string[] = AUTHORIZED, makeSecret: () => string = () => randomBytes(32).toString('base64url')): Promise<void> {
  const manifest = validateManifest(input, hashes);
  const snapshot = await inventory(client, manifest);
  const operator = 'ci-maintenance-' + required('RUN_ID');
  const operators = new Map<string, string>(); const secret = makeSecret();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) fail('operator token');
  operators.set(operator, secret);
  let active = ''; const boundary = metadataBoundary(client, snapshot, () => active, operator);
  const store = gcsStore({ bucket: client.bucket, prefix: 'm', getAccessToken: async () => client.token, fetch: boundary.fetch });
  const storage = ciphertextStorage(client, snapshot);
  const app = operatorApp(store, storage, operators);
  const allowed = new Set(manifest.targets.map(t => t.id));
  try {
    for (const [index, target] of manifest.targets.entries()) {
      active = target.id;
      try {
        const response = await invokeDelete(app, allowed, active, secret);
        if (!response.ok || boundary.faulted()) fail('delete failed');
        const data: unknown = await response.json();
        if (!object(data) || data.relic_id !== active || data.deleted !== true || data.blocklisted !== false) fail('delete response');
        console.log('slot ' + (index + 1) + ': handler completed');
      } catch { console.error('slot ' + (index + 1) + ': failed or partial'); throw Error('maintenance stopped'); }
    }
  } finally { active = ''; operators.clear(); }
}

async function main(): Promise<void> {
  validateRun(process.env);
  const manifest = validateManifest(JSON.parse(required('MAINTENANCE_MANIFEST')));
  delete process.env.MAINTENANCE_MANIFEST;
  if (process.argv[2] === 'validate') return;
  if (process.argv[2] !== 'execute') fail('action');
  const token = await accessToken();
  const client = new StorageClient('thebushido-co-relics', token);
  await execute(client, manifest);
}
if (import.meta.main) main().catch(() => { console.error('maintenance refused; inspect private state before any retry'); process.exitCode = 1; });
