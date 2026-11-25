import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptRelic } from '@relic/format';
import { nodeFiles } from '../src/files.ts';
import type { PublishDeps } from '../src/publish.ts';
import {
  handleMessage,
  INSTRUCTIONS,
  REQUEST_SIGNING_TOOL_DEFINITION,
  REQUEST_SIGNING_TOOL_NAME,
  SHARE_TOOL_DEFINITION,
  SHARE_TOOL_NAME,
} from '../src/server.ts';
import { savePrivatePublishState } from '../src/state.ts';
import { makeDevice, makePerson, pinDevice } from './private-fixtures.ts';
import { fetchUpload } from './upload-fixture.ts';

const ORIGIN = 'https://relic.example';
const PRIVATE_ID = 'tvwxyz0123456789abcdefghjk';
const KEY = 'AAAAAAAAAAAAAAAAAAAAAA';

let dir: string;
let deps: PublishDeps;
let fetchCalls: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relic-private-share-'));
  process.env['RELIC_PUBLISH_STATE'] = join(dir, 'state.json');
  process.env['RELIC_DEVICE_KEYS'] = join(dir, 'device.json');
  fetchCalls = [];
  deps = {
    serviceOrigin: ORIGIN,
    relicOrigin: ORIGIN,
    files: nodeFiles,
    clientName: 'relic-mcp/private-share-test',
    upload: fetchUpload,
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
    fetch: (async (url: RequestInfo | URL) => {
      fetchCalls.push(String(url));
      throw new Error(`unexpected network call ${String(url)}`);
    }) as unknown as typeof fetch,
  };
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  delete process.env['RELIC_DEVICE_KEYS'];
  await rm(dir, { recursive: true, force: true });
});

async function savePrivateRelic(ownerIdentityId: string, deviceId: string) {
  await savePrivatePublishState(PRIVATE_ID, {
    access: 'private',
    service_origin: ORIGIN,
    publish_token: 'private-token',
    version: 1,
    version_keys: { '1': KEY },
    owner_identity_id: ownerIdentityId,
    device_id: deviceId,
  });
}

interface ToolResponse {
  result?: {
    isError?: boolean;
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolResponse> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    deps
  );
  if (!response) throw new Error('Expected a response');
  return response as ToolResponse;
}

describe('relic_share on a private relik', () => {
  test('returns grant_url with the addresses in the fragment and makes no service call', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('test');
    await pinDevice(ORIGIN, owner, device);
    await savePrivateRelic(owner.identityId, device.deviceId);

    const res = await callTool(SHARE_TOOL_NAME, {
      relic_id: PRIVATE_ID,
      emails: ['Ada@Example.test', 'grace@example.test'],
    });

    expect(res.result?.isError).toBeFalsy();
    expect(fetchCalls).toEqual([]);
    const data = res.result?.structuredContent as Record<string, unknown>;
    const grantUrl = new URL(data['grant_url'] as string);
    expect(grantUrl.origin + grantUrl.pathname).toBe(`${ORIGIN}/${PRIVATE_ID}`);
    expect(grantUrl.search).toBe('?access=share');
    expect(grantUrl.hash).toBe(
      `#to=${encodeURIComponent('Ada@Example.test,grace@example.test')}`
    );
    expect(data['registered']).toEqual([]);
    expect(data['shared_count']).toBe(0);
    expect(data['share_limit']).toBeNull();
  });

  test('keeps the keyless invitation draft for the owner and never carries the key', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('test');
    await pinDevice(ORIGIN, owner, device);
    await savePrivateRelic(owner.identityId, device.deviceId);

    const res = await callTool(SHARE_TOOL_NAME, {
      relic_id: PRIVATE_ID,
      emails: ['ada@example.test'],
    });
    const data = res.result?.structuredContent as {
      email: { to: string[]; subject: string; text: string };
      mailto_url: string;
    };
    expect(data.email.to).toEqual(['ada@example.test']);
    expect(data.email.subject).toBe('A private file shared with you on Relik');
    expect(data.email.text).toContain(`${ORIGIN}/${PRIVATE_ID}`);
    expect(data.email.text).toContain('The link alone opens nothing');
    expect(data.mailto_url.startsWith('mailto:ada@example.test?')).toBe(true);
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(fetchCalls).toEqual([]);
  });

  test('refuses a list of 0 or 21 addresses with local_share_emails_invalid before composing', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('test');
    await pinDevice(ORIGIN, owner, device);
    await savePrivateRelic(owner.identityId, device.deviceId);

    for (const emails of [
      [],
      Array.from({ length: 21 }, (_, i) => `person${i}@example.test`),
    ]) {
      const res = await callTool(SHARE_TOOL_NAME, {
        relic_id: PRIVATE_ID,
        emails,
      });
      expect(res.result?.isError).toBe(true);
      expect(res.result?.structuredContent?.['code']).toBe(
        'local_share_emails_invalid'
      );
      expect(res.result?.structuredContent?.['grant_url']).toBeUndefined();
    }
    expect(fetchCalls).toEqual([]);
  });
});

describe('relic_request_signatures refusal for a signer with no grant', () => {
  test('keeps recipient_forged_grant and carries signer_email and grant_url', async () => {
    const owner = await makePerson('owner@example.com');
    const device = await makeDevice('test');
    await pinDevice(ORIGIN, owner, device);
    await savePrivateRelic(owner.identityId, device.deviceId);
    const content = new TextEncoder().encode('private content');
    const ciphertext = await encryptRelic({
      content,
      filename: 'private.txt',
      mimetype: 'text/plain',
      key: new Uint8Array(16),
    });
    const routes: string[] = [];
    deps = {
      ...deps,
      fetch: (async (url: RequestInfo | URL) => {
        const path = String(url);
        routes.push(path);
        if (path.endsWith('/mint'))
          return Response.json({
            url: 'https://storage.test/private',
            object_length: ciphertext.length,
            version: 1,
            current_version: 1,
          });
        if (path === 'https://storage.test/private')
          return new Response(ciphertext.slice().buffer as ArrayBuffer);
        if (path.endsWith('/recipients')) return Response.json({ grants: [] });
        throw new Error(`unexpected route ${path}`);
      }) as typeof fetch,
    };

    const res = await callTool(REQUEST_SIGNING_TOOL_NAME, {
      relic_id: PRIVATE_ID,
      signers: [{ email: 'stranger@example.test' }],
      order: 'parallel',
      require_opened: false,
    });

    expect(res.result?.isError).toBe(true);
    const data = res.result?.structuredContent as Record<string, unknown>;
    expect(data['code']).toBe('recipient_forged_grant');
    expect(data['signer_email']).toBe('stranger@example.test');
    const grantUrl = new URL(data['grant_url'] as string);
    expect(grantUrl.origin + grantUrl.pathname).toBe(`${ORIGIN}/${PRIVATE_ID}`);
    expect(grantUrl.search).toBe('?access=share');
    expect(grantUrl.hash).toBe(
      `#to=${encodeURIComponent('stranger@example.test')}`
    );
    expect(JSON.stringify(res)).not.toContain(KEY);
    // The refusal happens before any signing request is posted.
    expect(routes.some((path) => path.endsWith('/signing/requests'))).toBe(
      false
    );
  });
});

describe('tool descriptions and instructions', () => {
  const described = [
    SHARE_TOOL_DEFINITION.description,
    REQUEST_SIGNING_TOOL_DEFINITION.description,
    INSTRUCTIONS,
  ];

  test('use the product word Relik, never Relic, and keep identifiers', () => {
    for (const text of described) {
      expect(text).not.toMatch(/\bRelic\b/);
      expect(text).not.toMatch(/\bRELIC\b/);
    }
    expect(SHARE_TOOL_DEFINITION.description).toContain('Relik');
  });

  test('use no em dash or en dash', () => {
    for (const text of described) {
      expect(text).not.toMatch(/[\u2013\u2014]/);
    }
  });

  test('state that relic_share grants and invites nothing on a private relik', () => {
    expect(SHARE_TOOL_DEFINITION.description).toContain('grant_url');
    expect(SHARE_TOOL_DEFINITION.description).toContain(
      'grants and invites nothing'
    );
    expect(INSTRUCTIONS).toContain('relic_share returns grant_url');
  });
});
