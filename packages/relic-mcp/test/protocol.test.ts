import { beforeEach, describe, expect, test } from 'bun:test';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { createHttpHandler } from '../src/http.ts';
import {
  decodeHeaderValue,
  ERROR_CODES,
  expectedMcpName,
  isSupportedVersion,
  PROTOCOL_VERSION,
  requestedProtocolVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../src/protocol.ts';
import type { FileReader, PublishDeps } from '../src/publish.ts';
import { handleMessage, INSTRUCTIONS, TOOL_NAME } from '../src/server.ts';

const SERVICE = 'https://relic.example';
const META = 'io.modelcontextprotocol/protocolVersion';

let deps: PublishDeps;
let handler: ReturnType<typeof createHttpHandler>;

function files(): FileReader {
  return {
    resolve: (p) => `/work/${p}`,
    basename: (p) => p.slice(p.lastIndexOf('/') + 1),
    async stat() {
      return { kind: 'file', size: 5 };
    },
    async read() {
      return new TextEncoder().encode('hello');
    },
    async openBundleRoot() {
      let rootClosed = false;
      return {
        async openRegular() {
          if (rootClosed) throw new Error('bundle root is closed');
          let fileClosed = false;
          const bytes = new TextEncoder().encode('hello');
          return {
            size: bytes.length,
            async readBounded(maxBytes) {
              if (fileClosed) throw new Error('bundle file is closed');
              if (bytes.length > maxBytes) throw new Error('EFBIG');
              return bytes;
            },
            async close() {
              fileClosed = true;
            },
          };
        },
        async close() {
          rootClosed = true;
        },
      };
    },
  };
}

beforeEach(() => {
  const app = createApp({
    store: new MemoryStore(),
    storage: new MemoryStorage(),
  });
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: files(),
    fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(new Request(String(input), init))) as typeof globalThis.fetch,
    clientName: 'test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
  handler = createHttpHandler(deps);
});

function post(
  body: unknown,
  headers: Record<string, string> = {},
  init: RequestInit = {}
): Request {
  return new Request('http://127.0.0.1:7333/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
    ...init,
  });
}

function rpc(method: string, params: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method,
    params: { ...params, _meta: { [META]: PROTOCOL_VERSION } },
  };
}

function standardHeaders(
  method: string,
  name?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'mcp-protocol-version': PROTOCOL_VERSION,
    'mcp-method': method,
  };
  if (name !== undefined) headers['mcp-name'] = name;
  return headers;
}

describe('the pinned revision', () => {
  test('is 2026-07-28, the stateless one', () => {
    expect(PROTOCOL_VERSION).toBe('2026-07-28');
  });

  test('still answers the handshake-based revisions', () => {
    // Legacy clients have no fall-forward mechanism, so dropping these makes
    // Relic unreachable from them with no diagnostic they can surface.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-06-18');
    expect(isSupportedVersion('2025-06-18')).toBe(true);
    expect(isSupportedVersion('1900-01-01')).toBe(false);
  });
});

describe('per-request versioning', () => {
  test('reads the version out of _meta', () => {
    expect(
      requestedProtocolVersion({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { [META]: '2026-07-28' } },
      })
    ).toBe('2026-07-28');
  });

  test('a request with no _meta declares nothing, which is not an error', () => {
    expect(
      requestedProtocolVersion({ jsonrpc: '2.0', id: 1, method: 'ping' })
    ).toBeUndefined();
  });

  test('an unsupported version is refused with -32022 and the supported list', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: { _meta: { [META]: '1900-01-01' } },
      },
      deps
    );

    expect(response?.error?.code).toBe(ERROR_CODES.unsupportedProtocolVersion);
    const data = response?.error?.data as {
      supported: string[];
      requested: string;
    };
    expect(data.requested).toBe('1900-01-01');
    expect(data.supported).toContain(PROTOCOL_VERSION);
  });

  test('server/discover is never refused for its declared version', async () => {
    // It is the probe a client uses to find out what the server speaks, so
    // refusing it would leave the client no way to recover.
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: { _meta: { [META]: '1900-01-01' } },
      },
      deps
    );
    expect(response?.error).toBeUndefined();
  });
});

describe('server/discover', () => {
  test('returns versions, capabilities, and identity in one request', async () => {
    const response = await handleMessage(rpc('server/discover'), deps);
    const result = response?.result as {
      protocolVersions: string[];
      capabilities: Record<string, unknown>;
      serverInfo: { name: string };
    };

    expect(result.protocolVersions[0]).toBe(PROTOCOL_VERSION);
    expect(result.capabilities).toHaveProperty('tools');
    expect(result.serverInfo.name).toBe('relic');
  });
});

describe('the version the server reports', () => {
  test('is a build stamp, not a literal that goes stale', async () => {
    // The published 0.2.0 tarball introduced itself to every client as
    // 0.1.0, because the version was written into the source by hand. An
    // unbuilt run reports a dev marker rather than claiming a release.
    const { SERVER_VERSION } = await import('../src/server.ts');
    expect(SERVER_VERSION).toBe('0.0.0-dev');
  });

  test('is stamped from package.json when the bundle is built', async () => {
    const root = new URL('../', import.meta.url).pathname;
    const pkg = (await Bun.file(`${root}package.json`).json()) as {
      version: string;
    };

    const build = Bun.spawn(['bun', 'run', 'build.ts'], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(await build.exited).toBe(0);

    const bundle = await Bun.file(`${root}dist/relic-mcp.js`).text();
    expect(bundle).toContain(pkg.version);
    expect(bundle).not.toContain('process.env.RELIC_MCP_VERSION');
  });
});

describe('the handshake carries instructions', () => {
  test('server/discover includes instructions', async () => {
    const response = await handleMessage(rpc('server/discover'), deps);
    const result = response?.result as { instructions?: string };
    expect(typeof result.instructions).toBe('string');
    expect(result.instructions?.length).toBeGreaterThan(0);
  });

  test('the legacy initialize includes instructions', async () => {
    const response = await handleMessage(
      rpc('initialize', { protocolVersion: PROTOCOL_VERSION }),
      deps
    );
    const result = response?.result as { instructions?: string };
    expect(typeof result.instructions).toBe('string');
    expect(result.instructions?.length).toBeGreaterThan(0);
  });

  test('stays short because it costs context every session', () => {
    expect(INSTRUCTIONS.length).toBeLessThan(2300);
  });
});

describe('the legacy handshake still works', () => {
  test('initialize is answered, which makes this a dual-era server', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      deps
    );
    const result = response?.result as { protocolVersion: string };
    expect(result.protocolVersion).toBe('2025-06-18');
  });

  test('an initialize for an unknown version still names what is supported', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '1900-01-01' },
      },
      deps
    );
    const result = response?.result as { protocolVersion: string };
    expect(result.protocolVersion).toBe(PROTOCOL_VERSION);
  });
});

describe('Streamable HTTP is stateless', () => {
  test('answers tools/list on a bare POST with no prior handshake', async () => {
    const response = await handler(
      post(rpc('tools/list'), standardHeaders('tools/list'))
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools[0]?.name).toBe(TOOL_NAME);
  });

  test('mints no session id and echoes none', async () => {
    const response = await handler(
      post(rpc('tools/list'), standardHeaders('tools/list'))
    );
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  test('ignores a session id an older client sends', async () => {
    const response = await handler(
      post(rpc('tools/list'), {
        ...standardHeaders('tools/list'),
        'mcp-session-id': 'stale-session',
      })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('mcp-session-id')).toBeNull();
  });

  test('two independent requests both succeed, in either order', async () => {
    const first = await handler(
      post(rpc('server/discover'), standardHeaders('server/discover'))
    );
    const second = await handler(
      post(rpc('tools/list'), standardHeaders('tools/list'))
    );
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test('refuses GET and DELETE, which this revision removed', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await handler(
        new Request('http://127.0.0.1:7333/mcp', { method })
      );
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('POST');
    }
  });
});

describe('mirrored routing headers', () => {
  test('requires MCP-Protocol-Version', async () => {
    const response = await handler(
      post(rpc('tools/list'), { 'mcp-method': 'tools/list' })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ERROR_CODES.headerMismatch);
  });

  test('requires Mcp-Method', async () => {
    const response = await handler(
      post(rpc('tools/list'), { 'mcp-protocol-version': PROTOCOL_VERSION })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ERROR_CODES.headerMismatch);
  });

  test('rejects a header that disagrees with the body', async () => {
    // The split-brain this prevents: a gateway routes on the header while the
    // server executes on the body.
    const response = await handler(
      post(rpc('tools/list'), {
        'mcp-protocol-version': PROTOCOL_VERSION,
        'mcp-method': 'tools/call',
      })
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe(ERROR_CODES.headerMismatch);
    expect(body.error.message).toContain('does not match body value');
  });

  test('rejects a version header that disagrees with _meta', async () => {
    const response = await handler(
      post(rpc('tools/list'), {
        'mcp-protocol-version': '2025-06-18',
        'mcp-method': 'tools/list',
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ERROR_CODES.headerMismatch);
  });

  test('requires Mcp-Name on tools/call and checks it against the body', async () => {
    const missing = await handler(
      post(
        rpc('tools/call', { name: TOOL_NAME, arguments: { path: 'a.md' } }),
        standardHeaders('tools/call')
      )
    );
    expect(missing.status).toBe(400);

    const wrong = await handler(
      post(
        rpc('tools/call', { name: TOOL_NAME, arguments: { path: 'a.md' } }),
        standardHeaders('tools/call', 'something_else')
      )
    );
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error.code).toBe(ERROR_CODES.headerMismatch);
  });

  test('accepts a matching Mcp-Name', async () => {
    const response = await handler(
      post(
        rpc('tools/call', { name: TOOL_NAME, arguments: { path: 'a.md' } }),
        standardHeaders('tools/call', TOOL_NAME)
      )
    );
    expect(response.status).toBe(200);
  });

  test('decodes the base64 sentinel before comparing', () => {
    expect(decodeHeaderValue('=?base64?SGVsbG8sIOS4lueVjA==?=')).toBe(
      'Hello, 世界'
    );
    expect(decodeHeaderValue('plain')).toBe('plain');
  });

  test('knows which methods carry a name and which do not', () => {
    expect(
      expectedMcpName({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'x' },
      })
    ).toBe('x');
    expect(
      expectedMcpName({
        jsonrpc: '2.0',
        id: 1,
        method: 'resources/read',
        params: { uri: 'file:///a' },
      })
    ).toBe('file:///a');
    expect(
      expectedMcpName({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    ).toBeUndefined();
  });
});

describe('DNS rebinding defence', () => {
  test('refuses an origin that is not allowed', async () => {
    // A page on any website can otherwise reach a server bound to loopback.
    const response = await handler(
      post(rpc('tools/list'), {
        ...standardHeaders('tools/list'),
        origin: 'https://evil.example',
      })
    );
    expect(response.status).toBe(403);
  });

  test('accepts an allowed origin', async () => {
    const permissive = createHttpHandler(deps, {
      allowedOrigins: ['https://trusted.example'],
    });
    const response = await permissive(
      post(rpc('tools/list'), {
        ...standardHeaders('tools/list'),
        origin: 'https://trusted.example',
      })
    );
    expect(response.status).toBe(200);
  });

  test('a request with no Origin is allowed, which is the non-browser case', async () => {
    const response = await handler(
      post(rpc('tools/list'), standardHeaders('tools/list'))
    );
    expect(response.status).toBe(200);
  });
});

describe('error status mapping', () => {
  test('an unknown method is 404 with -32601, not a bare 404', async () => {
    // The JSON-RPC body is what distinguishes a modern server from a legacy
    // one that simply does not host this path.
    const response = await handler(
      post(rpc('nope/method'), standardHeaders('nope/method'))
    );
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe(ERROR_CODES.methodNotFound);
  });

  test('an unsupported version is 400 with -32022', async () => {
    const response = await handler(
      post(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: { _meta: { [META]: '1900-01-01' } },
        },
        { 'mcp-protocol-version': '1900-01-01', 'mcp-method': 'tools/list' }
      )
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(
      ERROR_CODES.unsupportedProtocolVersion
    );
  });

  test('unparseable JSON is 400 with -32700', async () => {
    const response = await handler(
      new Request('http://127.0.0.1:7333/mcp', {
        method: 'POST',
        headers: {
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': 'tools/list',
        },
        body: 'not json',
      })
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(ERROR_CODES.parseError);
  });

  test('a notification is accepted with 202 and no body', async () => {
    const response = await handler(
      post(
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        {
          'mcp-protocol-version': PROTOCOL_VERSION,
          'mcp-method': 'notifications/initialized',
        }
      )
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });
});
