import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeFiles } from '../src/files.ts';
import type { PublishDeps } from '../src/publish.ts';
import { handleMessage, SETTINGS_TOOL_DEFINITION } from '../src/server.ts';
import { savePrivatePublishState, savePublishState } from '../src/state.ts';
import { fetchUpload } from './upload-fixture.ts';

const id = '0123456789abcdefghjkmnpqrs';
const privateId = 'tvwxyz0123456789abcdefghjk';
const settings = {
  suggestions: true,
  comments: true,
  decisions: false,
  signing: true,
  notifications: true,
  changed_at: null,
  changed_by: null,
  expires_at: null,
};
let dir: string;
let body: unknown;
let response: Response;
let requests: string[];
let deps: PublishDeps;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relik-settings-'));
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'state.json');
  await savePublishState(id, {
    key: 'AAAAAAAAAAAAAAAAAAAAAA',
    publish_token: 'secret-token',
    version: 1,
  });
  await savePrivatePublishState(privateId, {
    access: 'private',
    service_origin: 'https://svc.test',
    publish_token: 'private-token',
    version: 1,
    version_keys: { '1': 'BBBBBBBBBBBBBBBBBBBBBB' },
    owner_identity_id: 'a'.repeat(64),
    device_id: 'b'.repeat(64),
  });
  body = undefined;
  requests = [];
  response = Response.json({
    relic_id: id,
    settings: { ...settings, secret: 'must-not-escape' },
    relic_expires_at: null,
    publish_token: 'must-not-escape',
  });
  deps = {
    serviceOrigin: 'https://svc.test',
    relicOrigin: 'https://svc.test',
    files: nodeFiles,
    clientName: 'test',
    upload: fetchUpload,
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'not used',
    }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(String(input));
      body = JSON.parse(String(init?.body));
      expect(init?.method).toBe('POST');
      return response.clone();
    }) as typeof fetch,
  };
});
afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(dir, { recursive: true, force: true });
});

async function call(args: Record<string, unknown>) {
  return handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'relic_settings', arguments: args },
    },
    deps
  );
}

test('reads without writing settings and never returns token or unexpected fields', async () => {
  const res = await call({ relic_id: id });
  expect(requests).toEqual([`https://svc.test/api/relics/${id}/settings`]);
  expect(body).toEqual({ publish_token: 'secret-token', settings: {} });
  expect((res?.result as Record<string, unknown>)['structuredContent']).toEqual(
    {
      relic_id: id,
      settings,
      relic_expires_at: null,
    }
  );
  expect(JSON.stringify(res)).not.toContain('secret-token');
  expect(JSON.stringify(res)).not.toContain('must-not-escape');
});

test('show returns settings from the mint response when present', async () => {
  deps = {
    ...deps,
    fetch: (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/mint')) {
        return Response.json({
          url: 'https://storage.invalid/object',
          current_version: 1,
          object_length: 100,
          relic_expires_at: null,
          settings,
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  const res = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'relic_show', arguments: { relic_id: id } },
    },
    deps
  );
  expect(
    (res?.result as Record<string, unknown>)['structuredContent']
  ).toMatchObject({ settings });
});

test('maps all switches and null lifetime without dropping false values', async () => {
  const changes = {
    suggestions: false,
    comments: false,
    decisions: true,
    signing: false,
    notifications: false,
    ttl_days: null,
  };
  await call({ relic_id: id, ...changes });
  expect(body).toEqual({ publish_token: 'secret-token', settings: changes });
  await call({ relic_id: id, ttl_days: 23 });
  expect(body).toEqual({
    publish_token: 'secret-token',
    settings: { ttl_days: 23 },
  });
});

test('private state uses its own token', async () => {
  response = Response.json({
    relic_id: privateId,
    settings,
    relic_expires_at: null,
  });
  await call({ relic_id: privateId, comments: false });
  expect(body).toEqual({
    publish_token: 'private-token',
    settings: { comments: false },
  });
});

test('server refusal preserves settings check and actionable guidance', async () => {
  response = Response.json(
    {
      code: 'invalid_settings',
      detail: 'invalid lifetime',
      settings_check: 'private_lifetime',
    },
    { status: 400 }
  );
  const res = await call({ relic_id: privateId, ttl_days: null });
  expect((res?.result as Record<string, unknown>)['isError']).toBe(true);
  expect(
    (res?.result as Record<string, unknown>)['structuredContent']
  ).toMatchObject({
    code: 'invalid_settings',
    settings_check: 'private_lifetime',
  });
  expect(JSON.stringify(res)).toContain('Check settings_check');
});

test('missing local state refuses before making a request', async () => {
  const res = await call({ relic_id: '00000000000000000000000000' });
  expect(
    (res?.result as Record<string, unknown>)['structuredContent']
  ).toMatchObject({
    code: 'no_local_publish_state',
  });
  expect(requests).toHaveLength(0);
});

test('description states enforcement and correct brand', () => {
  const text = SETTINGS_TOOL_DEFINITION.description;
  for (const part of [
    'viewer only',
    'encrypted comment',
    'publisher and owner',
    'without republishing',
    'not yet enforced',
    'access-request or grant mail',
    'erasure earlier',
  ])
    expect(text).toContain(part);
  expect(text).not.toMatch(/\brelic\b/i);
});
