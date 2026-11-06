import { createHash, randomBytes } from 'node:crypto';
import { createApp } from '../packages/relic-server/src/app.ts';
import { gcsStore } from '../packages/relic-server/src/gcsstore.ts';
import type { ObjectStorage } from '../packages/relic-server/src/storage.ts';

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
