import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeKey,
  deriveShareProof,
  encodeKey,
  type DecisionList,
  type DecisionRecord,
  isVersionDigest,
  versionDigest,
} from '@relic/format';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { readDecisions } from '../src/decisions.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, PublishError, publish } from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { ERROR_CODES } from '../src/protocol.ts';
import {
  INSTRUCTIONS,
  READ_DECISIONS_TOOL_DEFINITION,
  READ_DECISIONS_TOOL_NAME,
  REPUBLISH_TOOL_DEFINITION,
  TOOL_DEFINITION,
  handleMessage,
} from '../src/server.ts';
import { loadPublishState, savePublishState } from '../src/state.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let storage: MemoryStorage;
let app: RelicApp;
let deps: PublishDeps;
let fetchedUrls: string[];
let postedDecisionsListBody: Record<string, unknown> | null;
let mockCompleteResponse: Record<string, unknown> | null;
let mockDecisionsListResponse: { status: number; body: unknown } | null;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-decisions-test-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');

  storage = new MemoryStorage();
  app = createApp({
    store: new MemoryStore(),
    storage,
    now: () => Date.now(),
    operatorTokens: new Map([['jason', 'operator-secret']]),
  });

  fetchedUrls = [];
  postedDecisionsListBody = null;
  mockCompleteResponse = null;
  mockDecisionsListResponse = null;

  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: createMockFetch(),
    clientName: 'relic-mcp/decisions-test',
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

function createMockFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    fetchedUrls.push(url.pathname);

    // Mock complete response if specified
    if (url.pathname.endsWith('/complete') && mockCompleteResponse !== null) {
      return new Response(JSON.stringify(mockCompleteResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    // Intercept decisions/list if mock response is set
    if (url.pathname.endsWith('/decisions/list')) {
      if (init?.body) {
        postedDecisionsListBody = JSON.parse(String(init.body)) as Record<
          string,
          unknown
        >;
      }
      if (mockDecisionsListResponse !== null) {
        return new Response(
          typeof mockDecisionsListResponse.body === 'string'
            ? mockDecisionsListResponse.body
            : JSON.stringify(mockDecisionsListResponse.body),
          {
            status: mockDecisionsListResponse.status,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
    }

    // Storage PUT
    if (url.hostname === 'storage.invalid') {
      const key = url.pathname.replace(/^\/(?:upload|o)\//, '');
      if (init?.method === 'PUT') {
        const bodyBytes =
          init.body instanceof Uint8Array
            ? init.body
            : new Uint8Array(Buffer.from(init?.body as ArrayBuffer));
        storage.put(key, bodyBytes);
        return new Response(null, { status: 200 });
      }
      const bytes = await storage.read(key);
      if (bytes === undefined) return new Response(null, { status: 404 });
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }

    // App fetch
    if (url.origin === SERVICE) {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }

    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

describe('tools/list and tool definitions', () => {
  test('tools/list returns 12 tools and only relic_read_decisions matches decision pattern', async () => {
    const res = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      deps
    );
    expect(res).toBeDefined();
    if (!res?.result) throw new Error('expected result');
    const tools = (res.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.length).toBe(12);

    const matching = tools.filter((t) =>
      /decision|approv|reject|verdict/i.test(t.name)
    );
    expect(matching.length).toBe(1);
    expect(matching[0]?.name).toBe('relic_read_decisions');
  });

  test('relic_read_decisions definition matches spec §4.7 input and output schemas', () => {
    expect(READ_DECISIONS_TOOL_DEFINITION.name).toBe('relic_read_decisions');
    expect(READ_DECISIONS_TOOL_DEFINITION.inputSchema.required).toEqual([
      'relic_id',
    ]);
    expect(
      READ_DECISIONS_TOOL_DEFINITION.inputSchema.additionalProperties
    ).toBe(false);
    expect(READ_DECISIONS_TOOL_DEFINITION.outputSchema.required).toEqual([
      'relic_id',
      'current_version',
      'decisions',
    ]);
    expect(
      READ_DECISIONS_TOOL_DEFINITION.outputSchema.additionalProperties
    ).toBe(false);

    const decisionItemSchema =
      READ_DECISIONS_TOOL_DEFINITION.outputSchema.properties.decisions.items;
    expect(decisionItemSchema.required).toEqual([
      'id',
      'version',
      'verdict',
      'author',
      'created_at',
      'version_digest',
    ]);
    expect(decisionItemSchema.additionalProperties).toBe(false);
    expect(decisionItemSchema.properties.verdict.enum).toEqual([
      'approve',
      'reject',
    ]);
    expect(decisionItemSchema.properties.version_digest.pattern).toBe(
      '^[0-9a-f]{64}$'
    );
  });

  test('publish and republish output schemas include version_digest', () => {
    expect(TOOL_DEFINITION.outputSchema.required).toContain('version_digest');
    expect(TOOL_DEFINITION.outputSchema.properties).toHaveProperty(
      'version_digest'
    );

    expect(REPUBLISH_TOOL_DEFINITION.outputSchema.required).toContain(
      'version_digest'
    );
    expect(REPUBLISH_TOOL_DEFINITION.outputSchema.properties).toHaveProperty(
      'version_digest'
    );
  });

  test('INSTRUCTIONS includes item 10 regarding passkeys and decisions', () => {
    expect(INSTRUCTIONS).toContain(
      'Decisions are made by a person in the viewer with a passkey'
    );
    expect(INSTRUCTIONS).toContain('no tool records them');
    expect(INSTRUCTIONS).toContain('comment text never creates one');
  });
});

describe('relic_read_decisions parameter validation', () => {
  test('missing relic_id returns -32602 error', async () => {
    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: {},
        },
      },
      deps
    );
    expect(res?.error).toBeDefined();
    expect(res?.error?.code).toBe(ERROR_CODES.invalidParams);
  });

  test('empty string relic_id returns -32602 error', async () => {
    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: '' },
        },
      },
      deps
    );
    expect(res?.error).toBeDefined();
    expect(res?.error?.code).toBe(ERROR_CODES.invalidParams);
  });

  test.each([0, -1, 1.5, 'invalid', true, {}])(
    'invalid version %p returns -32602 error',
    async (badVersion) => {
      const res = await handleMessage(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: READ_DECISIONS_TOOL_NAME,
            arguments: {
              relic_id: '0123456789abcdef0123456789',
              version: badVersion,
            },
          },
        },
        deps
      );
      expect(res?.error).toBeDefined();
      expect(res?.error?.code).toBe(ERROR_CODES.invalidParams);
    }
  );
});

describe('foreign relic and machine boundary', () => {
  test('relic not published by this machine returns no_local_publish_state', async () => {
    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: '0123456789abcdef0123456789' },
        },
      },
      deps
    );
    expect(res?.result).toBeDefined();
    const result = res?.result as {
      isError: boolean;
      structuredContent: { code: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('no_local_publish_state');
  });
});

describe('wire protocol and mint safety', () => {
  test('relic_read_decisions never calls /mint and sends share_proof', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Hello world for decisions test\n');

    const pub = await publish({ path: sourceFile }, deps);
    expect(pub.relic_id).toBeDefined();

    mockDecisionsListResponse = {
      status: 200,
      body: {
        relic_id: pub.relic_id,
        current_version: 1,
        decisions: [
          {
            id: 'dec-1',
            version: 1,
            verdict: 'approve',
            author: 'alice@example.com',
            created_at: '2026-10-24T20:00:00.000Z',
            version_digest: 'a'.repeat(64),
          },
        ],
      },
    };

    fetchedUrls = [];
    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id, version: 1 },
        },
      },
      deps
    );

    // Verify /mint was NEVER called
    expect(fetchedUrls.some((u) => u.includes('/mint'))).toBe(false);

    // Verify decisions/list was called
    expect(fetchedUrls.some((u) => u.endsWith('/decisions/list'))).toBe(true);

    // Verify share_proof was sent in body
    expect(postedDecisionsListBody).toBeDefined();
    expect(typeof postedDecisionsListBody?.['share_proof']).toBe('string');
    const proofStr = String(postedDecisionsListBody?.['share_proof'] ?? '');
    expect(proofStr.length).toBe(43);
    expect(postedDecisionsListBody?.['version']).toBe(1);

    // Verify structuredContent matches DecisionList shape
    expect(res?.result).toBeDefined();
    const result = res?.result as {
      isError: boolean;
      structuredContent: DecisionList;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.relic_id).toBe(pub.relic_id);
    expect(result.structuredContent.current_version).toBe(1);
    expect(result.structuredContent.decisions.length).toBe(1);
    expect(result.structuredContent.decisions[0]?.verdict).toBe('approve');
    expect(result.content[0]?.text).toContain(
      'alice@example.com: approve version 1'
    );
  });

  test('relic_read_decisions accepts "*" version', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Hello world for decisions test\n');

    const pub = await publish({ path: sourceFile }, deps);

    mockDecisionsListResponse = {
      status: 200,
      body: {
        relic_id: pub.relic_id,
        current_version: 2,
        decisions: [],
      },
    };

    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id, version: '*' },
        },
      },
      deps
    );

    expect(postedDecisionsListBody?.['version']).toBe('*');
    expect(res?.result).toBeDefined();
    const result = res?.result as {
      isError: boolean;
      structuredContent: DecisionList;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.decisions).toEqual([]);
    expect(result.content[0]?.text).toContain(
      'No decisions recorded on any version'
    );
  });

  test('relic_read_decisions shape-checks invalid server responses', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Hello world for decisions test\n');

    const pub = await publish({ path: sourceFile }, deps);

    // Missing current_version
    mockDecisionsListResponse = {
      status: 200,
      body: {
        relic_id: pub.relic_id,
        decisions: [],
      },
    };

    const res1 = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id },
        },
      },
      deps
    );
    const r1 = res1?.result as {
      isError: boolean;
      structuredContent: { code: string };
    };
    expect(r1.isError).toBe(true);
    expect(r1.structuredContent.code).toBe('app_response_unusable');

    // Invalid verdict in decision record
    mockDecisionsListResponse = {
      status: 200,
      body: {
        relic_id: pub.relic_id,
        current_version: 1,
        decisions: [
          {
            id: 'dec-1',
            version: 1,
            verdict: 'maybe',
            author: 'bob@example.com',
            created_at: '2026-10-24T20:00:00.000Z',
            version_digest: 'a'.repeat(64),
          },
        ],
      },
    };

    const res2 = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id },
        },
      },
      deps
    );
    const r2 = res2?.result as {
      isError: boolean;
      structuredContent: { code: string };
    };
    expect(r2.isError).toBe(true);
    expect(r2.structuredContent.code).toBe('app_response_unusable');
  });

  test('relic_read_decisions handles legacy server 404 with app_response_unusable', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Hello world for decisions test\n');

    const pub = await publish({ path: sourceFile }, deps);

    mockDecisionsListResponse = {
      status: 404,
      body: { code: 'unknown', detail: 'Not found' },
    };

    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id },
        },
      },
      deps
    );
    const r = res?.result as {
      isError: boolean;
      structuredContent: { code: string };
    };
    expect(r.isError).toBe(true);
    expect(r.structuredContent.code).toBe('app_response_unusable');
  });
  test('relic_read_decisions against real server endpoint returns initial empty decision list', async () => {
    const sourceFile = join(scratch, 'real-doc.txt');
    await writeFile(sourceFile, 'Real server decisions test content\n');

    const pub = await publish({ path: sourceFile }, deps);
    expect(pub.relic_id).toBeDefined();
    expect(pub.version_digest).toBeDefined();

    // No mockDecisionsListResponse: request goes directly to real app.fetch!
    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 100,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id },
        },
      },
      deps
    );

    expect(res?.result).toBeDefined();
    const result = res?.result as {
      isError: boolean;
      structuredContent: DecisionList;
      content: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.relic_id).toBe(pub.relic_id);
    expect(result.structuredContent.current_version).toBe(1);
    expect(result.structuredContent.decisions).toEqual([]);
    expect(result.content[0]?.text).toContain('No decisions recorded');
  });
});

describe('version_digest in publish and republish', () => {
  test('publish result carries version_digest', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Document content for version digest\n');

    const pub = await publish({ path: sourceFile }, deps);
    expect(pub.version_digest).toBeDefined();
    expect(isVersionDigest(pub.version_digest)).toBe(true);
  });

  test('publish throws version_digest_mismatch when server digest differs', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Document content for mismatch test\n');

    mockCompleteResponse = {
      version: 1,
      version_digest: 'b'.repeat(64),
    };

    expect(publish({ path: sourceFile }, deps)).rejects.toThrow(PublishError);
    try {
      await publish({ path: sourceFile }, deps);
    } catch (err) {
      expect(err).toBeInstanceOf(PublishError);
      const pe = err as PublishError;
      expect(pe.code).toBe('version_digest_mismatch');
      expect(pe.details['server']).toBe('b'.repeat(64));
      expect(typeof pe.details['local']).toBe('string');
    }
  });

  test('republish result carries version_digest', async () => {
    const sourceFile1 = join(scratch, 'doc-v1.txt');
    await writeFile(sourceFile1, 'Version 1 content\n');

    const pub = await publish({ path: sourceFile1 }, deps);

    const sourceFile2 = join(scratch, 'doc-v2.txt');
    await writeFile(sourceFile2, 'Version 2 updated content\n');

    const rep = await republish(
      { relic_id: pub.relic_id, path: sourceFile2 },
      deps
    );
    expect(rep.version_digest).toBeDefined();
    expect(isVersionDigest(rep.version_digest)).toBe(true);
    expect(rep.version).toBe(2);
  });

  test('republish throws version_digest_mismatch when server digest differs', async () => {
    const sourceFile1 = join(scratch, 'doc-v1.txt');
    await writeFile(sourceFile1, 'Version 1 content\n');

    const pub = await publish({ path: sourceFile1 }, deps);

    const sourceFile2 = join(scratch, 'doc-v2.txt');
    await writeFile(sourceFile2, 'Version 2 updated content\n');

    mockCompleteResponse = {
      version: 2,
      version_digest: 'f'.repeat(64),
    };

    expect(
      republish({ relic_id: pub.relic_id, path: sourceFile2 }, deps)
    ).rejects.toThrow(PublishError);
  });

  test('republish reports server version when server is ahead of local state', async () => {
    const sourceFile1 = join(scratch, 'doc-v1.txt');
    await writeFile(sourceFile1, 'Version 1 content\n');

    const pub = await publish({ path: sourceFile1 }, deps);

    const sourceFile2 = join(scratch, 'doc-v2.txt');
    await writeFile(sourceFile2, 'Version 2 content\n');

    // Server complete returns version 3 (server is ahead)
    mockCompleteResponse = {
      version: 3,
      version_digest: null,
    };

    const rep = await republish(
      { relic_id: pub.relic_id, path: sourceFile2 },
      deps
    );
    expect(rep.version).toBe(3);

    // Verify local state was updated to version 3
    const state = await loadPublishState(pub.relic_id);
    expect(state?.version).toBe(3);
  });
});

describe('REFUSAL_GUIDANCE', () => {
  test('decision_unavailable provides republish guidance', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Content\n');
    const pub = await publish({ path: sourceFile }, deps);

    mockDecisionsListResponse = {
      status: 409,
      body: {
        code: 'decision_unavailable',
        detail: 'Decisions unavailable until publisher republishes',
      },
    };

    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id },
        },
      },
      deps
    );

    const r = res?.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain(
      'republish once with relic_republish; the link does not change'
    );
  });

  test('decision_rate_limited provides retry guidance', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Content\n');
    const pub = await publish({ path: sourceFile }, deps);

    mockDecisionsListResponse = {
      status: 429,
      body: {
        code: 'decision_rate_limited',
        detail: 'Rate limit exceeded',
        retry_after_seconds: 60,
      },
    };

    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id },
        },
      },
      deps
    );

    const r = res?.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain(
      'The service is rate limiting decisions'
    );
    expect(r.content[0]?.text).toContain('retry_after_seconds');
  });

  test('invalid_share_proof provides share proof guidance', async () => {
    const sourceFile = join(scratch, 'doc.txt');
    await writeFile(sourceFile, 'Content\n');
    const pub = await publish({ path: sourceFile }, deps);

    mockDecisionsListResponse = {
      status: 403,
      body: {
        code: 'invalid_share_proof',
        detail: 'Share proof verification failed',
      },
    };

    const res = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: READ_DECISIONS_TOOL_NAME,
          arguments: { relic_id: pub.relic_id },
        },
      },
      deps
    );

    const r = res?.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toContain(
      'The share proof was rejected by the service'
    );
  });
});
