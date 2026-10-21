import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeKey,
  deriveShareProof,
  relicUrl,
  shareVerifierFor,
} from '@relic/format';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import {
  handleMessage,
  REPUBLISH_TOOL_NAME,
  SHARE_TOOL_NAME,
} from '../src/server.ts';
import { loadPublishState } from '../src/state.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let deps: PublishDeps;
let lastShareRequest: { url: string; body: Record<string, unknown> } | null =
  null;
let lastGrantBody: Record<string, unknown> | null = null;
let lastRepublishBody: Record<string, unknown> | null = null;
let shareResponseOverride: {
  status: number;
  body: unknown;
  isRaw?: boolean;
} | null = null;
let uploadedContainers = new Map<string, Uint8Array>();

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-share-test-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  lastShareRequest = null;
  lastGrantBody = null;
  lastRepublishBody = null;
  shareResponseOverride = null;
  uploadedContainers = new Map();

  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: mockFetch(),
    clientName: 'relic-mcp/share-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
});

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function mockFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));

    if (url.hostname === 'storage.invalid' && init?.method === 'PUT') {
      if (init?.body) {
        const bodyBytes =
          init.body instanceof Uint8Array
            ? init.body
            : new Uint8Array(Buffer.from(init.body as ArrayBuffer));
        const id = url.pathname.replace(/^\/upload\//, '');
        uploadedContainers.set(id, bodyBytes);
      }
      return new Response(null, { status: 200 });
    }

    if (
      url.hostname === 'storage.invalid' &&
      (!init?.method || init?.method === 'GET')
    ) {
      const id = url.pathname.replace(/^\/download\//, '');
      const bytes =
        uploadedContainers.get(id) ??
        uploadedContainers.get('first') ??
        new Uint8Array(0);
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    if (url.pathname.match(/\/api\/relics\/[^/]+\/mint$/)) {
      const match = url.pathname.match(/\/api\/relics\/([^/]+)\/mint$/);
      const relicId = match?.[1] ?? 'first';
      const bytes = uploadedContainers.get(relicId) ?? new Uint8Array(0);
      return Response.json({
        url: `https://storage.invalid/download/${relicId}`,
        object_length: bytes.length,
        version: 1,
        current_version: 1,
      });
    }

    if (url.pathname.match(/\/api\/relics\/[^/]+\/comments$/)) {
      return Response.json([]);
    }

    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'share-challenge',
        size_limit_bytes: 10_000_000,
        size_basis: 'plaintext',
      });
    }

    if (url.pathname === '/api/grant') {
      if (init?.body) {
        lastGrantBody = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
      }
      return Response.json({
        publish_token: 'share-test-publish-token',
        upload_url: 'https://storage.invalid/upload/first',
        relic_expires_at: null,
        report_url: `${SERVICE}/abuse`,
        disclosure_url: `${SERVICE}/disclosure`,
      });
    }

    if (url.pathname.endsWith('/complete')) {
      return Response.json({});
    }

    if (url.pathname.match(/\/api\/relics\/[^/]+\/republish$/)) {
      if (init?.body) {
        lastRepublishBody = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
      }
      return Response.json({
        publish_token: 'share-test-publish-token',
        upload_url: 'https://storage.invalid/upload/next',
        relic_expires_at: null,
        report_url: `${SERVICE}/abuse`,
        disclosure_url: `${SERVICE}/disclosure`,
      });
    }

    if (url.pathname.match(/\/api\/relics\/[^/]+\/share$/)) {
      if (shareResponseOverride) {
        if (shareResponseOverride.isRaw) {
          return new Response(String(shareResponseOverride.body), {
            status: shareResponseOverride.status,
            headers: { 'content-type': 'text/html' },
          });
        }
        return Response.json(shareResponseOverride.body, {
          status: shareResponseOverride.status,
        });
      }

      if (init?.body) {
        lastShareRequest = {
          url: url.toString(),
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
        };
      }
      const match = url.pathname.match(/\/api\/relics\/([^/]+)\/share$/);
      const relicId = match?.[1] ?? 'first';
      const emails = (lastShareRequest?.body?.['emails'] as string[]) ?? [];
      const normalized = emails.map((e) => e.trim().toLowerCase());
      return Response.json({
        relic_id: relicId,
        emails: normalized,
        added: normalized.length,
        shared_count: normalized.length,
        share_limit: 50,
        title: 'Test Document',
      });
    }

    return new Response('Not found', { status: 404 });
  }) as typeof globalThis.fetch;
}

async function publishFixture(title?: string): Promise<string> {
  const filePath = join(scratch, 'test-doc.md');
  await writeFile(filePath, '# Test content\n');
  const result = await publish({ path: filePath, title }, deps);
  return result.relic_id;
}

interface ToolCallResult {
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

interface ToolCallResponse {
  result?: ToolCallResult;
  error?: { code: number; message: string; data?: unknown };
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<ToolCallResponse> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    deps
  );
  if (!response) throw new Error('Expected response');
  return response as ToolCallResponse;
}

describe('relic_share tool and shareRelic', () => {
  test('refuses a share URL, non-id, and a relic published elsewhere before any request', async () => {
    const relicId = await publishFixture();
    const state = await loadPublishState(relicId);
    if (!state) throw new Error('State missing');
    const key = decodeKey(state.key);
    const fullUrl = relicUrl(SERVICE, relicId, key);

    lastShareRequest = null;

    // Non-id
    const nonIdRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: 'not-a-valid-id',
      emails: ['ada@example.test'],
    });
    expect(nonIdRes.result?.isError).toBe(true);
    const nonIdText = nonIdRes.result?.content?.[0]?.text ?? '';
    expect(nonIdText).toContain('no_local_publish_state');
    expect(nonIdText).toContain('These tools take the 26-character id');
    expect(lastShareRequest).toBeNull();

    // Share URL
    const urlRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: fullUrl,
      emails: ['ada@example.test'],
    });
    expect(urlRes.result?.isError).toBe(true);
    const urlText = urlRes.result?.content?.[0]?.text ?? '';
    expect(urlText).toContain('no_local_publish_state');
    expect(urlText).toContain('never the share URL');
    expect(lastShareRequest).toBeNull();

    // Published elsewhere (valid 26-char id not in local state)
    const otherId = '0123456789abcdef0123456789';
    const otherRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: otherId,
      emails: ['ada@example.test'],
    });
    expect(otherRes.result?.isError).toBe(true);
    const otherText = otherRes.result?.content?.[0]?.text ?? '';
    expect(otherText).toContain('no_local_publish_state');
    expect(otherText).toContain(
      'can only be shared from the machine that published it'
    );
    expect(lastShareRequest).toBeNull();
  });

  test('the emails count check works', async () => {
    const relicId = await publishFixture();

    // 0 emails
    const emptyRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: [],
    });
    expect(emptyRes.result?.isError).toBe(true);
    const emptyText = emptyRes.result?.content?.[0]?.text ?? '';
    expect(emptyText).toContain('local_share_emails_invalid');

    // >20 emails
    const over20 = Array.from(
      { length: 21 },
      (_, i) => `user${i}@example.test`
    );
    const overRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: over20,
    });
    expect(overRes.result?.isError).toBe(true);
    const overText = overRes.result?.content?.[0]?.text ?? '';
    expect(overText).toContain('local_share_emails_invalid');

    // 1 email works
    const oneRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['single@example.test'],
    });
    expect(oneRes.result?.isError).toBe(false);

    // 20 emails works
    const exactly20 = Array.from(
      { length: 20 },
      (_, i) => `user${i}@example.test`
    );
    const twentyRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: exactly20,
    });
    expect(twentyRes.result?.isError).toBe(false);
  });

  test('the request posts exactly {publish_token, emails}', async () => {
    const relicId = await publishFixture();
    const state = await loadPublishState(relicId);
    if (!state) throw new Error('State missing');

    await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['Ada@example.test', 'Grace@example.test'],
    });

    expect(lastShareRequest).not.toBeNull();
    expect(lastShareRequest?.url).toBe(
      `${SERVICE}/api/relics/${relicId}/share`
    );
    const bodyKeys = Object.keys(lastShareRequest?.body ?? {}).sort();
    expect(bodyKeys).toEqual(['emails', 'publish_token']);
    expect(lastShareRequest?.body['publish_token']).toBe(state.publish_token);
    expect(lastShareRequest?.body['emails']).toEqual([
      'Ada@example.test',
      'Grace@example.test',
    ]);
  });

  test('the email is composed from the service normalized addresses and title, with URL in body', async () => {
    const relicId = await publishFixture('My Project Spec');
    const state = await loadPublishState(relicId);
    if (!state) throw new Error('State missing');
    const key = decodeKey(state.key);
    const expectedUrl = relicUrl(SERVICE, relicId, key);

    const res = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['Ada@Example.test', 'grace@EXAMPLE.test'],
    });

    expect(res.result?.isError).toBe(false);
    const structured = (res.result?.structuredContent ?? {}) as unknown as {
      email: { to: string[]; subject: string; text: string };
      mailto_url: string;
      registered: string[];
    };

    expect(structured.registered).toEqual([
      'ada@example.test',
      'grace@example.test',
    ]);
    expect(structured.email.to).toEqual([
      'ada@example.test',
      'grace@example.test',
    ]);
    expect(structured.email.subject).toBe('Shared with you: Test Document');
    expect(structured.email.text).toContain(
      `I've shared "Test Document" with you on Relic. Open it here:`
    );
    expect(structured.email.text).toContain(expectedUrl);
    expect(structured.email.text).toContain(
      'When someone comments or I publish a new version'
    );
    expect(structured.email.text).toContain(
      'Relic keeps your address for that.'
    );
  });

  test('the mailto link has to, subject and a CRLF body', async () => {
    const relicId = await publishFixture();
    const res = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['user1@example.test', 'user2@example.test'],
    });

    expect(res.result?.isError).toBe(false);
    const structured = (res.result?.structuredContent ?? {}) as unknown as {
      mailto_url: string;
      email: { to: string[]; subject: string; text: string };
    };
    const mailto = structured.mailto_url;
    expect(
      mailto.startsWith('mailto:user1@example.test,user2@example.test?')
    ).toBe(true);
    expect(mailto).toContain(
      `subject=${encodeURIComponent(structured.email.subject)}`
    );
    // RFC 6068 CRLF in encoded body
    expect(mailto).toContain('%0D%0A');
    expect(mailto).not.toContain('%0A%0A');
  });

  test('a refusal passes through with its code and guidance', async () => {
    const relicId = await publishFixture();

    // share_limit_reached
    shareResponseOverride = {
      status: 409,
      body: {
        code: 'share_limit_reached',
        relic_id: relicId,
        share_limit: 50,
        shared_count: 50,
      },
    };
    const limitRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['new@example.test'],
    });
    expect(limitRes.result?.isError).toBe(true);
    const limitText = limitRes.result?.content?.[0]?.text ?? '';
    expect(limitText).toContain('share_limit_reached:');
    expect(limitText).toContain(
      'That relic already has the most shared addresses the service allows'
    );

    // invalid_share
    shareResponseOverride = {
      status: 400,
      body: {
        code: 'invalid_share',
        relic_id: relicId,
        share_max_per_call: 20,
      },
    };
    const invalidRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['bad'],
    });
    expect(invalidRes.result?.isError).toBe(true);
    const invalidText = invalidRes.result?.content?.[0]?.text ?? '';
    expect(invalidText).toContain('invalid_share:');
    expect(invalidText).toContain('Every entry must be one email address');

    // share_rate_limited
    shareResponseOverride = {
      status: 429,
      body: {
        code: 'share_rate_limited',
        retry_after_seconds: 60,
      },
    };
    const rateRes = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['rate@example.test'],
    });
    expect(rateRes.result?.isError).toBe(true);
    const rateText = rateRes.result?.content?.[0]?.text ?? '';
    expect(rateText).toContain('share_rate_limited:');
    expect(rateText).toContain(
      'The refusal carries retry_after_seconds; wait it out rather than retrying in a loop.'
    );
  });

  test('a plain 404 becomes app_response_unusable', async () => {
    const relicId = await publishFixture();
    shareResponseOverride = {
      status: 404,
      body: '<html><body>404 Not Found</body></html>',
      isRaw: true,
    };

    const res = await callTool(SHARE_TOOL_NAME, {
      relic_id: relicId,
      emails: ['user@example.test'],
    });
    expect(res.result?.isError).toBe(true);
    const text = res.result?.content?.[0]?.text ?? '';
    expect(text).toContain('app_response_unusable');
    expect(text).toContain(
      'This Relic service does not support relic_share yet.'
    );
  });
});

describe('republish notify parameter and share_verifier', () => {
  test('republish omits notify by default and sends notify: false when asked; non-boolean is invalidParams', async () => {
    const relicId = await publishFixture();
    const filePath = join(scratch, 'test-doc.md');
    await writeFile(filePath, '# Updated content\n');

    // Default: notify is omitted on wire, result.notify is true
    lastRepublishBody = null;
    const defaultRes = await callTool(REPUBLISH_TOOL_NAME, {
      relic_id: relicId,
      path: filePath,
    });
    expect(defaultRes.result?.isError).toBe(false);
    expect(lastRepublishBody).not.toBeNull();
    expect('notify' in (lastRepublishBody ?? {})).toBe(false);
    const defaultStruct = (defaultRes.result?.structuredContent ??
      {}) as unknown as { notify: boolean };
    expect(defaultStruct.notify).toBe(true);
    const defaultText = defaultRes.result?.content?.[0]?.text ?? '';
    expect(defaultText).toContain(
      'Relic sends a change notice for version 2 to each address that commented on this relic or was added with relic_share'
    );
    // notify: false sent on wire
    await writeFile(filePath, '# Version 3 content\n');
    lastRepublishBody = null;
    const falseRes = await callTool(REPUBLISH_TOOL_NAME, {
      relic_id: relicId,
      path: filePath,
      notify: false,
    });
    expect(falseRes.result?.isError).toBe(false);
    expect(lastRepublishBody?.['notify'] === false).toBe(true);
    const falseStruct = (falseRes.result?.structuredContent ??
      {}) as unknown as { notify: boolean };
    expect(falseStruct.notify).toBe(false);
    const falseText = falseRes.result?.content?.[0]?.text ?? '';
    expect(falseText).toContain(
      'No change notice goes out for this version, as asked.'
    );
    // non-boolean notify is invalidParams
    const nonBoolRes = await callTool(REPUBLISH_TOOL_NAME, {
      relic_id: relicId,
      path: filePath,
      notify: 'false',
    });
    expect('error' in nonBoolRes).toBe(true);
    expect(
      (nonBoolRes as { error: { message: string } }).error.message
    ).toContain('`notify` must be a boolean or omitted');
  });

  test('publish and republish ALWAYS send share_verifier derived from the key', async () => {
    const relicId = await publishFixture();
    const state = await loadPublishState(relicId);
    if (!state) throw new Error('State missing');
    const key = decodeKey(state.key);
    const expectedVerifier = await shareVerifierFor(
      await deriveShareProof(key)
    );

    // Verify publish sent share_verifier
    expect(lastGrantBody).not.toBeNull();
    expect(lastGrantBody?.['share_verifier']).toBe(expectedVerifier);

    // Verify republish sent share_verifier
    const filePath = join(scratch, 'test-doc.md');
    await writeFile(filePath, '# New version\n');
    await callTool(REPUBLISH_TOOL_NAME, {
      relic_id: relicId,
      path: filePath,
    });

    expect(lastRepublishBody).not.toBeNull();
    expect(lastRepublishBody?.['share_verifier']).toBe(expectedVerifier);
  });
});
