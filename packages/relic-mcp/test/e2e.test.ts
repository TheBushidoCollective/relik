import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile as readStateFile,
  rm,
  writeFile as writeStateFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeKey,
  MAX_TITLE_CHARS,
  openRelic,
  PLAINTEXT_CAP_BYTES,
  parseFragment,
  parseRelicId,
} from '@relic/format';
import { createApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import {
  type FileReader,
  guessMimetype,
  type PublishDeps,
  PublishError,
  publish,
  ServerRefusal,
} from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import {
  describeClient,
  handleMessage,
  INSTRUCTIONS,
  REPUBLISH_TOOL_DEFINITION,
  REPUBLISH_TOOL_NAME,
  TOOL_DEFINITION,
  TOOL_NAME,
} from '../src/server.ts';
import { publishStateModes, publishStatePath } from '../src/state.ts';

const SERVICE = 'https://relic.example';
const VERSION_HISTORY_DISCLOSURE =
  "Anyone holding a relic's link can fetch every version it has ever held, " +
  'so republishing does not withdraw earlier content.';

let now = Date.parse('2026-08-02T12:00:00.000Z');
let storage: MemoryStorage;
let app: ReturnType<typeof createApp>;
let disk: Map<string, Uint8Array>;
let deps: PublishDeps;

/** A filesystem that lives in a Map, so the flow runs without a disk. */
function fakeFiles(): FileReader {
  return {
    resolve: (path) => (path.startsWith('/') ? path : `/work/${path}`),
    basename: (path) => path.slice(path.lastIndexOf('/') + 1),
    async stat(path) {
      if (path.endsWith('/')) return { kind: 'directory' };
      if (path === '/work/a-directory') return { kind: 'directory' };
      if (path === '/work/a-fifo') return { kind: 'other' };
      const bytes = disk.get(path);
      if (bytes === undefined) return { kind: 'other' };
      return { kind: 'file', size: bytes.length };
    },
    async read(path) {
      const bytes = disk.get(path);
      if (bytes === undefined) throw new Error('ENOENT');
      return bytes;
    },
    async openBundleRoot(rootPath) {
      let rootClosed = false;
      return {
        async openRegular(relativePath) {
          if (rootClosed) throw new Error('bundle root is closed');
          const bytes = disk.get(`${rootPath}/${relativePath}`);
          if (bytes === undefined) {
            const error = Object.assign(new Error('ENOENT'), {
              code: 'ENOENT',
            });
            throw error;
          }
          let fileClosed = false;
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

/** Routes service URLs at the app and storage URLs at MemoryStorage. */
function shimFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));

    if (url.origin === SERVICE) {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }

    if (url.hostname === 'storage.invalid') {
      // Object keys are the bare id for version 1 and `{id}/v{n}` from
      // version 2 on, so the key is everything after the route prefix
      // rather than whichever segment happens to sit second.
      const key = url.pathname.replace(/^\/(?:upload|o)\//, '');

      if (init?.method === 'PUT') {
        const body = init.body as Uint8Array;
        storage.put(key, new Uint8Array(body));
        return new Response(null, { status: 200 });
      }

      const bytes = await storage.read(key);
      if (bytes === undefined) return new Response(null, { status: 404 });
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }

    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

/** Records every /api/grant request body, so tests see the wire, not intent. */
function captureGrants(
  sink: Record<string, unknown>[]
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.pathname === '/api/grant') {
      sink.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
    return deps.fetch(input, init);
  }) as typeof globalThis.fetch;
}

/**
 * Records every republish request body and every storage PUT target, so
 * tests see which version's object was written and what rode the request.
 */
function captureRepublish(
  bodies: Record<string, unknown>[],
  uploads: string[]
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.pathname.endsWith('/republish')) {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    }
    if (init?.method === 'PUT' && url.hostname === 'storage.invalid') {
      uploads.push(url.pathname);
    }
    return deps.fetch(input, init);
  }) as typeof globalThis.fetch;
}

let stateScratch: string;

beforeEach(async () => {
  now = Date.parse('2026-08-02T12:00:00.000Z');
  storage = new MemoryStorage();
  disk = new Map();
  app = createApp({
    store: new MemoryStore(),
    storage,
    now: () => now,
    operatorTokens: new Map([['jason', 'operator-secret']]),
  });
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: fakeFiles(),
    fetch: shimFetch(),
    clientName: 'relic-mcp/0.1.0 (test)',
    identifySource: async (path) => ({
      identity: `realpath:${encodeURIComponent(path)}`,
      kind: 'realpath',
      path,
      description: path,
    }),
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };

  // Redirected per test, into a directory this run created, so no test
  // touches a real config directory and the permission assertions read
  // modes the client itself chose.
  stateScratch = await mkdtemp(join(tmpdir(), 'relic-publish-state-'));
  process.env['RELIC_PUBLISH_STATE'] = join(
    stateScratch,
    'relic-mcp',
    'publish-state.json'
  );
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(stateScratch, { recursive: true, force: true });
});

function writeFile(path: string, content: string | Uint8Array): void {
  disk.set(
    path,
    typeof content === 'string' ? new TextEncoder().encode(content) : content
  );
}

/** The parsed publish state file, read from the path the client itself uses. */
interface StoredEntry {
  key: string;
  publish_token: string;
  version: number;
  content_sha256?: string;
}

async function readStoredState(): Promise<{
  relics: Record<string, StoredEntry>;
}> {
  return JSON.parse(await readStateFile(publishStatePath(), 'utf8')) as {
    relics: Record<string, StoredEntry>;
  };
}
/** Stand in for the viewer: mint, fetch, decrypt. */
async function open(url: string, ip = '203.0.113.5') {
  const parsed = new URL(url);
  const relicId = parsed.pathname.slice(1);
  const { key, version } = parseFragment(parsed.hash);

  const mintResponse = await app.fetch(
    new Request(`${SERVICE}/api/relics/${relicId}/mint`, {
      method: 'POST',
      headers: { 'x-forwarded-for': ip },
    })
  );
  if (!mintResponse.ok) {
    return {
      mintStatus: mintResponse.status,
      problem: await mintResponse.json(),
    };
  }

  const mint = (await mintResponse.json()) as {
    url: string;
    object_length: number;
  };
  const bytes = new Uint8Array(
    await (await deps.fetch(mint.url)).arrayBuffer()
  );
  expect(bytes.length).toBe(mint.object_length);

  const opened = await openRelic(bytes, key, version);
  return { mintStatus: 200, opened, mint };
}

describe('the whole loop', () => {
  test('publishes a markdown file and a recipient reads it back byte for byte', async () => {
    const body = '# Q3 report\n\nRevenue was up.\n';
    writeFile('/work/report.md', body);

    const result = await publish({ path: 'report.md' }, deps);

    expect(result.relic_id).toBe(parseRelicId(result.relic_id));
    expect(result.renderer_class).toBe('markdown');
    expect(result.filename).toBe('report.md');
    expect(result.resolved_path).toBe('/work/report.md');

    now += 10 * 60 * 1000;
    const viewed = await open(result.url);

    expect(viewed.mintStatus).toBe(200);
    expect(new TextDecoder().decode(viewed.opened?.content)).toBe(body);
    expect(viewed.opened?.envelope.entries[0]?.filename).toBe('report.md');
    expect(viewed.opened?.envelope.entries[0]?.mimetype).toBe('text/markdown');
  });

  test('round trips a binary payload', async () => {
    const png = new Uint8Array(5000);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    for (let index = 8; index < png.length; index++) png[index] = index % 251;
    writeFile('/work/chart.png', png);

    const result = await publish({ path: 'chart.png' }, deps);
    expect(result.renderer_class).toBe('image');

    now += 10 * 60 * 1000;
    const viewed = await open(result.url);
    expect([...(viewed.opened?.content ?? [])]).toEqual([...png]);
  });

  test('round trips a zero-byte file, which classes as binary', async () => {
    writeFile('/work/empty.md', new Uint8Array(0));

    const result = await publish({ path: 'empty.md' }, deps);
    expect(result.renderer_class).toBe('binary');

    now += 10 * 60 * 1000;
    const viewed = await open(result.url);
    expect(viewed.opened?.content).toHaveLength(0);
  });

  test('round trips content spanning many records', async () => {
    const big = new Uint8Array(400_000);
    for (let index = 0; index < big.length; index++) big[index] = index % 256;
    writeFile('/work/big.bin', big);

    const result = await publish({ path: 'big.bin' }, deps);
    now += 10 * 60 * 1000;
    const viewed = await open(result.url);
    expect([...(viewed.opened?.content ?? [])]).toEqual([...big]);
  });

  test('the filename override reaches the envelope, and the server as the title', async () => {
    writeFile('/work/tmp-xyz.md', 'hello');
    const result = await publish(
      { path: 'tmp-xyz.md', filename: 'Q3-layoffs-final.md' },
      deps
    );

    now += 10 * 60 * 1000;
    const viewed = await open(result.url);
    expect(viewed.opened?.envelope.entries[0]?.filename).toBe(
      'Q3-layoffs-final.md'
    );

    // This assertion was the reverse of itself until the plaintext title
    // landed, and `Q3-layoffs-final.md` was the example that argued against
    // it. The reversal is deliberate and it is bounded: the name crosses as
    // the title and nowhere else on the row, and the local path it was read
    // from still never crosses at all.
    const row = await app.store.getRelic(result.relic_id);
    expect(row?.title).toBe('Q3-layoffs-final.md');
    expect(JSON.stringify(row)).not.toContain('tmp-xyz');
  });

  test('an empty title keeps the name off the server entirely', async () => {
    writeFile('/work/tmp-xyz.md', 'hello');
    const result = await publish(
      { path: 'tmp-xyz.md', filename: 'Q3-layoffs-final.md', title: '' },
      deps
    );

    now += 10 * 60 * 1000;
    const viewed = await open(result.url);
    // The envelope still carries it, because that is inside the ciphertext.
    expect(viewed.opened?.envelope.entries[0]?.filename).toBe(
      'Q3-layoffs-final.md'
    );

    // The opt-out is the whole defence for defaulting the title to the
    // filename, so it is proven at the row rather than at the argument.
    const row = await app.store.getRelic(result.relic_id);
    expect(row?.title).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('Q3-layoffs-final');
    expect(JSON.stringify(row)).not.toContain('tmp-xyz');
    expect(result.title).toBeNull();
  });
});

describe('what the server never learns', () => {
  test('the key never appears in anything the server holds', async () => {
    writeFile('/work/secret.md', 'the numbers');
    const result = await publish({ path: 'secret.md' }, deps);
    const fragment = new URL(result.url).hash.slice(1);

    const everything = JSON.stringify({
      relic: await app.store.getRelic(result.relic_id),
      mintLog: await app.store.readMintLog(),
      reports: await app.store.readAbuseReports(),
    });
    expect(everything).not.toContain(fragment);
    expect(everything).not.toContain(fragment.slice(2));
  });

  test('the plaintext never appears in the stored object', async () => {
    const secret = 'CONFIDENTIAL-MARKER-9f3a';
    writeFile('/work/secret.md', `# Notes\n\n${secret}\n`);
    const result = await publish({ path: 'secret.md' }, deps);

    const stored = await storage.read(result.relic_id);
    expect(new TextDecoder().decode(stored)).not.toContain(secret);
  });

  test('the server stores the class, the client name, and the title, and nothing finer', async () => {
    writeFile('/work/notes.md', 'hello');
    const result = await publish({ path: 'notes.md' }, deps);

    const row = await app.store.getRelic(result.relic_id);
    expect(row?.rendererClass).toBe('markdown');
    expect(row?.publishingClient).toBe('relic-mcp/0.1.0 (test)');
    // The title is the filename by default and it is the only place the name
    // appears. The declared mimetype is still barred outright: it lives in
    // the encrypted envelope header and has no reason to cross.
    expect(row?.title).toBe('notes.md');
    expect(JSON.stringify(row)).not.toContain('text/markdown');
  });
});

describe('local refusals, before any HTTP', () => {
  test('refuses a directory and names the fix', async () => {
    await expect(publish({ path: 'a-directory' }, deps)).rejects.toMatchObject({
      code: 'source_is_directory',
    });
  });

  test('refuses a non-regular file', async () => {
    await expect(publish({ path: 'a-fifo' }, deps)).rejects.toMatchObject({
      code: 'source_not_regular_file',
    });
  });

  test('refuses a missing file', async () => {
    await expect(publish({ path: 'nope.md' }, deps)).rejects.toBeInstanceOf(
      PublishError
    );
  });

  test('the size precheck uses the server number, not a compiled-in constant', async () => {
    writeFile('/work/huge.bin', new Uint8Array(1024));
    const strict = createApp({
      store: new MemoryStore(),
      storage,
      now: () => now,
      config: { plaintextCapBytes: 512 },
    });
    app = strict;

    try {
      await publish({ path: 'huge.bin' }, deps);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(PublishError);
      const failure = error as PublishError;
      expect(failure.code).toBe('local_size_precheck_failed');
      expect(failure.details['size_limit_bytes']).toBe(512);
      expect(failure.details['size_basis']).toBe('plaintext');
    }
  });

  test('refuses an oversized raw .otioz before asking its reader for bytes', async () => {
    let reads = 0;
    const oversized: FileReader = {
      ...fakeFiles(),
      async stat() {
        return { kind: 'file', size: PLAINTEXT_CAP_BYTES + 1 };
      },
      async read() {
        reads += 1;
        return new Uint8Array();
      },
    };

    await expect(
      publish({ path: 'oversized.otioz' }, { ...deps, files: oversized })
    ).rejects.toMatchObject({ code: 'local_size_precheck_failed' });
    expect(reads).toBe(0);
  });

  test('a local refusal costs no grant', async () => {
    await publish({ path: 'a-directory' }, deps).catch(() => undefined);
    expect(await app.store.readMintLog()).toHaveLength(0);
  });
});

describe('server refusals reach the caller with their code', () => {
  test('a paused service surfaces service_paused', async () => {
    app = createApp({
      store: new MemoryStore(),
      storage,
      now: () => now,
      config: { killSwitchEngaged: true },
    });
    writeFile('/work/notes.md', 'hello');

    try {
      await publish({ path: 'notes.md' }, deps);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(ServerRefusal);
      expect((error as ServerRefusal).code).toBe('service_paused');
      expect((error as ServerRefusal).status).toBe(503);
    }
  });
});

describe('the recipient experience on a dead relic', () => {
  test('a removed relic reads as removed, never as a decrypt failure', async () => {
    writeFile('/work/notes.md', 'hello');
    const result = await publish({ path: 'notes.md' }, deps);

    await app.fetch(
      new Request(`${SERVICE}/api/relics/${result.relic_id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    const viewed = await open(result.url);
    expect(viewed.mintStatus).toBe(410);
    expect(viewed.problem.code).toBe('relic_removed');
    expect(viewed.problem.report_url).toBe(`${SERVICE}/abuse`);
  });

  test('an expired relic reads as expired', async () => {
    // Expiry is opt-in now, so this relic only dies because its publisher
    // said it should.
    writeFile('/work/notes.md', 'hello');
    const result = await publish({ path: 'notes.md', ttl_days: 7 }, deps);
    now += 8 * 86_400 * 1000;

    const viewed = await open(result.url);
    expect(viewed.mintStatus).toBe(410);
    expect(viewed.problem.code).toBe('relic_expired');
  });
});

describe('publisher-chosen lifetimes', () => {
  test('forwards ttl_days on the grant and reports the expiry date', async () => {
    writeFile('/work/notes.md', 'hello');
    const grants: Record<string, unknown>[] = [];

    const result = await publish(
      { path: 'notes.md', ttl_days: 3 },
      { ...deps, fetch: captureGrants(grants) }
    );

    expect(grants).toHaveLength(1);
    expect(grants[0]?.['ttl_days']).toBe(3);
    expect(Date.parse(result.relic_expires_at ?? '')).not.toBeNaN();

    // The lifetime took effect server-side, not just on the wire.
    const row = await app.store.getRelic(result.relic_id);
    expect(row?.expiresAt).toBe(now + 3 * 86_400 * 1000);
  });

  test('omits ttl_days when none was supplied, and the relic never expires', async () => {
    writeFile('/work/notes.md', 'hello');
    const grants: Record<string, unknown>[] = [];

    const result = await publish(
      { path: 'notes.md' },
      { ...deps, fetch: captureGrants(grants) }
    );

    expect(grants).toHaveLength(1);
    // The field is absent, not zero and not null: an unset lifetime is the
    // server's default to make, never this client's guess.
    expect('ttl_days' in (grants[0] ?? {})).toBe(false);
    expect(result.relic_expires_at).toBeNull();

    const row = await app.store.getRelic(result.relic_id);
    expect(row?.expiresAt).toBeUndefined();
  });

  test('a relic without a lifetime is still readable after any wait', async () => {
    writeFile('/work/notes.md', 'hello');
    const result = await publish({ path: 'notes.md' }, deps);
    now += 3650 * 86_400 * 1000;

    const viewed = await open(result.url);
    expect(viewed.mintStatus).toBe(200);
  });
});

describe('the MCP surface', () => {
  test('advertises every workflow tool and describe with product prefixes', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      deps
    );
    const result =
      response && 'result' in response
        ? (response.result as { tools: { name: string }[] })
        : { tools: [] };
    const tools = result.tools;
    expect(tools.map((tool) => tool.name)).toEqual([
      'relic_publish',
      'relic_list',
      'relic_show',
      'relic_lookup_source',
      'relic_republish',
      'relic_share',
      'relic_read_comments',
      'relic_comment',
      'relic_edit_comment',
      'relic_resolve_comment',
      'relic_describe_client',
    ]);
    for (const tool of tools) {
      expect(tool.name.startsWith('relic')).toBe(true);
    }
    expect(TOOL_NAME.startsWith('relic')).toBe(true);
  });

  test('publish and republish descriptions disclose retained history', () => {
    expect(TOOL_DEFINITION.description).toContain(VERSION_HISTORY_DISCLOSURE);
    expect(REPUBLISH_TOOL_DEFINITION.description).toContain(
      VERSION_HISTORY_DISCLOSURE
    );
  });

  test('describe_client reads nothing and sends nothing', async () => {
    // The inspection tool exists so a local client is not opaque to the agent
    // driving it. It must not be a second way to touch the disk or network.
    const before = disk.size;
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'relic_describe_client', arguments: {} },
      },
      deps
    );

    const result = response?.result as {
      isError: boolean;
      content: { text: string }[];
      structuredContent: Record<string, unknown>;
    };

    expect(result.isError).toBe(false);
    expect(disk.size).toBe(before);
    expect(result.structuredContent['key_transmitted_to_service']).toBe(false);
    expect(
      result.structuredContent['plaintext_bytes_transmitted_to_service']
    ).toBe(false);
    expect(result.structuredContent['cover_image']).toContain(
      'picture of the first screen'
    );
    expect(result.structuredContent['plaintext_title']).toBe(
      'relic title, defaulting to the source filename, stored by the service in the clear and shown by every link preview'
    );
  });
  test('describe_client states the transcript leak, not just the good news', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'relic_describe_client', arguments: {} },
      },
      deps
    );
    const result =
      response && 'result' in response
        ? (response.result as { content: { text: string }[] })
        : { content: [] };
    const text = result.content[0]?.text as string;

    expect(text).toContain('AES-128-GCM');
    expect(text).toContain('RFC 8188');
    expect(text).toContain('transcript');
    expect(text).toContain('never sent anywhere in');
  });

  test('accepts a path and a deliberate duplicate escape, never inline content', () => {
    const schema = TOOL_DEFINITION.inputSchema;
    expect(Object.keys(schema.properties)).toEqual([
      'path',
      'filename',
      'title',
      'ttl_days',
      'force_new',
      'cover',
    ]);
    expect(schema.properties.force_new).toMatchObject({
      type: 'boolean',
      default: false,
    });
    expect(schema.additionalProperties).toBe(false);
    // Inline content would put the plaintext in the transcript too,
    // compounding the leak from "the key leaks" to "the key and the file leak".
    expect(Object.keys(schema.properties)).not.toContain('content');
  });

  test('the schema declares the lifetime bounds the contract fixes', () => {
    const ttl = TOOL_DEFINITION.inputSchema.properties['ttl_days'];
    expect(ttl.type).toBe('integer');
    expect(ttl.minimum).toBe(1);
    expect(ttl.maximum).toBe(3650);
  });

  test('refuses a malformed ttl_days before any HTTP, like a missing path', async () => {
    const grants: Record<string, unknown>[] = [];

    for (const ttl_days of [0, -1, 3651, 1.5, '7']) {
      const response = await handleMessage(
        {
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: {
            name: TOOL_NAME,
            arguments: { path: 'notes.md', ttl_days },
          },
        },
        { ...deps, fetch: captureGrants(grants) }
      );
      // A lifetime the contract cannot honor means the call cannot be made;
      // answering it by publishing forever is the opposite of what was asked.
      expect(response?.error?.code).toBe(-32602);
    }
    expect(grants).toHaveLength(0);
  });

  test('a null relic_expires_at is reported as no expiry, not a bogus date', async () => {
    writeFile('/work/notes.md', '# hello');
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { path: 'notes.md' } },
      },
      deps
    );

    const result = response?.result as {
      isError: boolean;
      structuredContent: { relic_expires_at: string | null };
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.relic_expires_at).toBeNull();
    expect(result.content[0]?.text).toContain('does not expire');
    expect(result.content[0]?.text).not.toContain('Expires null');
  });

  test('tells the publisher of a page that external resources will not load', async () => {
    // The publisher is the only party who can act on it, by inlining what the
    // page needs, and the publish call is the only moment they are looking.
    writeFile('/work/page.html', '<!doctype html><h1>hi</h1>');
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 121,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { path: 'page.html' } },
      },
      deps
    );

    const result = response?.result as {
      structuredContent: { renderer_class: string };
      content: { text: string }[];
    };
    expect(result.structuredContent.renderer_class).toBe('html');
    expect(result.content[0]?.text).toContain('no network access');
    expect(result.content[0]?.text).toContain('Inline whatever the page needs');
  });

  test('spares a markdown publisher a note it cannot act on', async () => {
    writeFile('/work/notes.md', '# hello');
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 122,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { path: 'notes.md' } },
      },
      deps
    );

    const result = response?.result as { content: { text: string }[] };
    expect(result.content[0]?.text).not.toContain('no network access');
  });

  test('a ttl_days publish reports the expiry date in the same breath', async () => {
    writeFile('/work/notes.md', '# hello');
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'tools/call',
        params: {
          name: TOOL_NAME,
          arguments: { path: 'notes.md', ttl_days: 30 },
        },
      },
      deps
    );

    const result = response?.result as {
      isError: boolean;
      structuredContent: { relic_expires_at: string | null };
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    expect(typeof result.structuredContent.relic_expires_at).toBe('string');
    expect(result.content[0]?.text).toContain('Expires ');
  });

  test('does not expose the renderer class as an input', () => {
    expect(Object.keys(TOOL_DEFINITION.inputSchema.properties)).not.toContain(
      'renderer_class'
    );
  });

  test('answers initialize and server/discover', async () => {
    const legacy = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      },
      deps
    );
    const legacyResult =
      legacy && 'result' in legacy
        ? (legacy.result as { serverInfo: { name: string } })
        : { serverInfo: { name: '' } };
    expect(legacyResult.serverInfo.name).toBe('relic');

    const discover = await handleMessage(
      { jsonrpc: '2.0', id: 2, method: 'server/discover' },
      deps
    );
    const discoverResult =
      discover && 'result' in discover
        ? (discover.result as { protocolVersions: string[] })
        : { protocolVersions: [] };
    expect(discoverResult.protocolVersions).toContain('2026-07-28');
  });

  test('publish result discloses retained history without changing its structured shape', async () => {
    writeFile('/work/notes.md', '# hello');
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { path: 'notes.md' } },
      },
      deps
    );

    const result = response?.result as {
      structuredContent: Record<string, unknown> & { url: string };
      isError: boolean;
      content: { text: string }[];
    };
    expect(result.isError).toBe(false);
    expect(result.structuredContent.url).toContain('#r1');
    // The transcript consequence is disclosed in the same breath.
    expect(result.content[0]?.text).toContain('transcript');
    expect(
      result.content.some(({ text }) => text === VERSION_HISTORY_DISCLOSURE)
    ).toBe(true);
    expect(Object.keys(result.structuredContent).sort()).toEqual([
      'cover',
      'disclosure_url',
      'filename',
      'key_phrase',
      'relic_expires_at',
      'relic_id',
      'renderer_class',
      'report_url',
      'resolved_path',
      'title',
      'url',
      'version',
    ]);
    expect(result.structuredContent['version']).toBe(1);
  });

  test('a failed publish is a tool error, not a protocol error', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { path: 'a-directory' } },
      },
      deps
    );

    expect(response?.error).toBeUndefined();
    const result = response?.result as {
      isError: boolean;
      structuredContent: { code: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('source_is_directory');
  });

  test('a missing path is a protocol error, because the call cannot be made', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: {} },
      },
      deps
    );
    expect(response?.error?.code).toBe(-32602);
  });

  test('an unknown tool name is refused', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'publish', arguments: { path: 'notes.md' } },
      },
      deps
    );
    expect(response?.error?.code).toBe(-32602);
  });

  test('a notification gets no response', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      deps
    );
    expect(response).toBeUndefined();
  });
});

describe('republish', () => {
  test('takes a relic_id and a path, and never a publish_token argument', () => {
    const schema = REPUBLISH_TOOL_DEFINITION.inputSchema;
    expect(Object.keys(schema.properties)).toEqual([
      'relic_id',
      'path',
      'filename',
      'title',
      'ttl_days',
      'addresses',
      'cover',
      'notify',
    ]);
    expect(schema.required).toEqual(['relic_id', 'path']);
    expect(schema.additionalProperties).toBe(false);
    // The token is loaded from local state, never accepted as input: an
    // argument token would put the bearer secret in the transcript, which
    // is exactly where this design refuses to put it.
    expect(Object.keys(schema.properties)).not.toContain('publish_token');
  });

  test('a republish without a relic_id cannot be made', async () => {
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 40,
        method: 'tools/call',
        params: { name: REPUBLISH_TOOL_NAME, arguments: { path: 'notes.md' } },
      },
      deps
    );
    expect(response?.error?.code).toBe(-32602);
  });

  test('the result discloses retained history without changing its structured shape', async () => {
    writeFile('/work/report.md', '# v1\n');
    const first = await publish({ path: 'report.md' }, deps);
    writeFile('/work/report.md', '# v2\n');

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: REPUBLISH_TOOL_NAME,
          arguments: { relic_id: first.relic_id, path: 'report.md' },
        },
      },
      deps
    );
    const result = response?.result as {
      content: { text: string }[];
      isError: boolean;
      structuredContent: Record<string, unknown>;
    };

    expect(result.isError).toBe(false);
    expect(
      result.content.some(({ text }) => text === VERSION_HISTORY_DISCLOSURE)
    ).toBe(true);
    expect(Object.keys(result.structuredContent).sort()).toEqual([
      'cover',
      'disclosure_url',
      'filename',
      'key_phrase',
      'notify',
      'relic_expires_at',
      'relic_id',
      'renderer_class',
      'report_url',
      'resolved_path',
      'title',
      'version',
    ]);
  });

  test('a second publish to the same id is readable at the original URL', async () => {
    writeFile('/work/report.md', '# v1\n\nfirst\n');
    const first = await publish({ path: 'report.md' }, deps);

    writeFile('/work/report.md', '# v2\n\nsecond\n');
    const second = await republish(
      { relic_id: first.relic_id, path: 'report.md' },
      deps
    );

    expect(second.version).toBe(2);
    expect(second.relic_id).toBe(first.relic_id);
    expect(second.renderer_class).toBe('markdown');
    expect(second.relic_expires_at).toBeNull();
    // The unchanged URL is the promise a version makes. It is also the one
    // place the key lives outside the state file, so it is not reprinted.
    expect('url' in second).toBe(false);

    now += 10 * 60 * 1000;
    const viewed = await open(first.url);
    expect(viewed.mintStatus).toBe(200);
    expect(new TextDecoder().decode(viewed.opened?.content)).toBe(
      '# v2\n\nsecond\n'
    );
    expect(viewed.opened?.envelope.entries[0]?.filename).toBe('report.md');
  });

  test('reuses the stored key rather than generating a new one', async () => {
    writeFile('/work/notes.md', 'first');
    const first = await publish({ path: 'notes.md' }, deps);
    const { key } = parseFragment(new URL(first.url).hash);

    writeFile('/work/notes.md', 'second');
    await republish({ relic_id: first.relic_id, path: 'notes.md' }, deps);

    const stored = await readStoredState();
    // A fresh key would have been recorded here, and would have cut every
    // holder of the original link off from the new content.
    expect(stored.relics[first.relic_id]?.key).toBe(encodeKey(key));

    now += 10 * 60 * 1000;
    const viewed = await open(first.url);
    expect(new TextDecoder().decode(viewed.opened?.content)).toBe('second');
  });

  test('the filename override reaches the new version envelope', async () => {
    writeFile('/work/tmp-xyz.md', 'first');
    const first = await publish({ path: 'tmp-xyz.md' }, deps);

    writeFile('/work/tmp-xyz.md', 'second');
    await republish(
      { relic_id: first.relic_id, path: 'tmp-xyz.md', filename: 'final.md' },
      deps
    );

    now += 10 * 60 * 1000;
    const viewed = await open(first.url);
    expect(viewed.opened?.envelope.entries[0]?.filename).toBe('final.md');
  });

  test('forwards ttl_days when set, omits it when unset, and uploads to versioned paths', async () => {
    writeFile('/work/notes.md', 'first');
    const first = await publish({ path: 'notes.md' }, deps);

    const bodies: Record<string, unknown>[] = [];
    const uploads: string[] = [];
    const wire = { ...deps, fetch: captureRepublish(bodies, uploads) };

    writeFile('/work/notes.md', 'second');
    await republish({ relic_id: first.relic_id, path: 'notes.md' }, wire);
    expect('ttl_days' in (bodies[0] ?? {})).toBe(false);

    writeFile('/work/notes.md', 'third');
    await republish(
      { relic_id: first.relic_id, path: 'notes.md', ttl_days: 5 },
      wire
    );
    expect(bodies[1]?.['ttl_days']).toBe(5);

    // The wire carries the bearer token, the class from bytes, and the
    // declared sizes; the uploads land on the versioned object paths.
    expect(typeof bodies[0]?.['publish_token']).toBe('string');
    expect(bodies[0]?.['renderer_class']).toBe('markdown');
    expect(bodies[0]?.['declared_size_bytes']).toBe('second'.length);
    expect(uploads[0]).toBe(`/upload/${first.relic_id}/v2`);
    expect(uploads[1]).toBe(`/upload/${first.relic_id}/v3`);
  });

  test('counts versions locally, one per republish', async () => {
    writeFile('/work/notes.md', 'one');
    const first = await publish({ path: 'notes.md' }, deps);
    expect(first.version).toBe(1);

    writeFile('/work/notes.md', 'two');
    const second = await republish(
      { relic_id: first.relic_id, path: 'notes.md' },
      deps
    );
    writeFile('/work/notes.md', 'three');
    const third = await republish(
      { relic_id: first.relic_id, path: 'notes.md' },
      deps
    );
    expect(second.version).toBe(2);
    expect(third.version).toBe(3);

    const stored = await readStoredState();
    expect(stored.relics[first.relic_id]?.version).toBe(3);
  });
});

describe('local publish state', () => {
  test('writes the file 0600 inside a 0700 directory', async () => {
    writeFile('/work/notes.md', 'hello');
    await publish({ path: 'notes.md' }, deps);

    // Both are created by the client in this test, so the modes read here
    // are the ones it chose, not ones a fixture staged.
    const modes = await publishStateModes();
    expect(modes.file).toBe(0o600);
    expect(modes.directory).toBe(0o700);
  });

  test('records the id, the key, and the token of a version-1 publish', async () => {
    writeFile('/work/notes.md', 'hello');
    const result = await publish({ path: 'notes.md' }, deps);
    const { key } = parseFragment(new URL(result.url).hash);

    const stored = await readStoredState();
    const entry = stored.relics[result.relic_id];
    expect(entry?.key).toBe(encodeKey(key));
    expect(entry?.publish_token.length).toBeGreaterThan(20);
    expect(entry?.version).toBe(1);
  });

  test('refuses an id with no local state, without touching the network', async () => {
    writeFile('/work/notes.md', 'hello');
    let calls = 0;
    const counting = ((...args: Parameters<typeof globalThis.fetch>) => {
      calls += 1;
      return deps.fetch(...args);
    }) as typeof globalThis.fetch;

    let refusal: PublishError | undefined;
    try {
      await republish(
        { relic_id: '0123456789abcdefghjkmnpqst', path: 'notes.md' },
        { ...deps, fetch: counting }
      );
    } catch (error) {
      refusal = error as PublishError;
    }

    expect(refusal).toBeInstanceOf(PublishError);
    expect(refusal?.code).toBe('no_local_publish_state');
    expect(refusal?.message).toContain('another machine');
    expect(refusal?.message).toContain('cannot be republished here');
    // The refusal is decided locally, before any request can be made.
    expect(calls).toBe(0);
  });

  test('an id that is not a relic id is named as such, not as another machine', async () => {
    writeFile('/work/notes.md', 'hello');
    let refusal: PublishError | undefined;
    try {
      await republish({ relic_id: 'not-a-relic-id', path: 'notes.md' }, deps);
    } catch (error) {
      refusal = error as PublishError;
    }

    expect(refusal?.code).toBe('no_local_publish_state');
    expect(refusal?.message).toContain('is not a relic id');
    expect(refusal?.message).not.toContain('another machine');
  });

  test('a corrupt state file refuses loudly and echoes none of its bytes', async () => {
    writeFile('/work/notes.md', 'hello');
    const first = await publish({ path: 'notes.md' }, deps);

    // A torn tail, as a crash mid-write would leave: half of an entry that
    // happens to be readable text.
    await writeStateFile(
      publishStatePath(),
      '{"relics": {"broken-half": tru',
      'utf8'
    );

    let refusal: PublishError | undefined;
    try {
      await republish({ relic_id: first.relic_id, path: 'notes.md' }, deps);
    } catch (error) {
      refusal = error as PublishError;
    }

    expect(refusal?.code).toBe('local_state_unreadable');
    expect(refusal?.message).toContain('not valid JSON');
    // The error names the file and the consequence, never the bytes in it.
    expect(refusal?.message).not.toContain('broken-half');
  });

  test('a publish that cannot record state fails with the URL intact', async () => {
    writeFile('/work/notes.md', 'hello');
    const stateDirectory = join(stateScratch, 'relic-mcp');
    await mkdir(stateDirectory, { recursive: true });
    await chmod(stateDirectory, 0o500);

    let refusal: PublishError | undefined;
    try {
      await publish({ path: 'notes.md' }, deps);
    } catch (error) {
      refusal = error as PublishError;
    } finally {
      await chmod(stateDirectory, 0o700);
    }

    expect(refusal?.code).toBe('local_state_write_failed');
    expect(refusal?.message).toContain(
      'cannot be republished from this machine'
    );
    // The relic is live; handing its URL over in the failure is what keeps
    // a state problem from becoming a lost link.
    expect(String(refusal?.details['url'])).toContain('#r1');
  });
});

describe('duplicate versions', () => {
  test('an identical file is refused, and nothing reaches the network', async () => {
    writeFile('/work/notes.md', '# first\n');
    const first = await publish({ path: 'notes.md' }, deps);

    let calls = 0;
    const counting = ((...args: Parameters<typeof globalThis.fetch>) => {
      calls += 1;
      return deps.fetch(...args);
    }) as typeof globalThis.fetch;

    let refusal: PublishError | undefined;
    try {
      await republish(
        { relic_id: first.relic_id, path: 'notes.md' },
        { ...deps, fetch: counting }
      );
    } catch (error) {
      refusal = error as PublishError;
    }

    expect(refusal?.code).toBe('duplicate_version');
    expect(refusal?.message).toContain('already holds exactly this content');
    expect(refusal?.details['version']).toBe(1);
    // The service cannot answer this question: it holds ciphertext, and a
    // fresh salt makes two encryptions of one file differ. So the refusal
    // is decided here, and no request is spent on it.
    expect(calls).toBe(0);
    // The version it refused to add is the version still recorded.
    const stored = await readStoredState();
    expect(stored.relics[first.relic_id]?.version).toBe(1);
  });

  test('a changed byte is a real version, and the recorded digest moves with it', async () => {
    writeFile('/work/notes.md', '# first\n');
    const first = await publish({ path: 'notes.md' }, deps);
    const before = (await readStoredState()).relics[first.relic_id]
      ?.content_sha256;
    expect(before).toMatch(/^[0-9a-f]{64}$/);

    writeFile('/work/notes.md', '# first\n\nand a second line\n');
    const second = await republish(
      { relic_id: first.relic_id, path: 'notes.md' },
      deps
    );

    expect(second.version).toBe(2);
    const after = (await readStoredState()).relics[first.relic_id]
      ?.content_sha256;
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    // Recorded against the version that is now live, so a third republish
    // of this same file is the one that gets refused.
    expect(after).not.toBe(before);
    await expect(
      republish({ relic_id: first.relic_id, path: 'notes.md' }, deps)
    ).rejects.toMatchObject({ code: 'duplicate_version' });
  });

  test('a new title alone is a version, because it is what a recipient is shown', async () => {
    writeFile('/work/notes.md', '# first\n');
    const first = await publish({ path: 'notes.md' }, deps);

    // Same bytes, new title. The card and the link preview change, so a
    // recipient is being shown something they have not seen.
    const retitled = await republish(
      { relic_id: first.relic_id, path: 'notes.md', title: 'Q3 report' },
      deps
    );
    expect(retitled.version).toBe(2);
    expect(retitled.title).toBe('Q3 report');

    // And repeating that retitle is itself a duplicate.
    await expect(
      republish(
        { relic_id: first.relic_id, path: 'notes.md', title: 'Q3 report' },
        deps
      )
    ).rejects.toMatchObject({ code: 'duplicate_version' });
  });

  test('an entry written before the digest cannot be compared, so it republishes once and records one', async () => {
    writeFile('/work/notes.md', '# first\n');
    const first = await publish({ path: 'notes.md' }, deps);

    // Every entry on a real machine looks like this: published before the
    // digest was recorded, and unrepairable from anywhere, because the
    // service will not hand a client the plaintext to hash.
    const stored = await readStoredState();
    const entry = stored.relics[first.relic_id];
    if (entry === undefined) throw new Error('publish state entry is missing');
    delete entry.content_sha256;
    await writeStateFile(publishStatePath(), JSON.stringify(stored), 'utf8');

    const allowed = await republish(
      { relic_id: first.relic_id, path: 'notes.md' },
      deps
    );
    expect(allowed.version).toBe(2);

    // Self-healing: that republish recorded a digest, so the next identical
    // one is refused.
    expect(
      (await readStoredState()).relics[first.relic_id]?.content_sha256
    ).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      republish({ relic_id: first.relic_id, path: 'notes.md' }, deps)
    ).rejects.toMatchObject({ code: 'duplicate_version' });
  });

  test('a digest of the wrong shape is malformed state, not a comparison that quietly matches nothing', async () => {
    writeFile('/work/notes.md', '# first\n');
    const first = await publish({ path: 'notes.md' }, deps);

    const stored = await readStoredState();
    const entry = stored.relics[first.relic_id];
    if (entry === undefined) throw new Error('publish state entry is missing');
    entry.content_sha256 = 'not-a-digest';
    await writeStateFile(publishStatePath(), JSON.stringify(stored), 'utf8');

    // Refused loudly. Passing it through would compare against a value
    // nothing can equal, and the duplicate gate would be off with no word
    // about it anywhere.
    await expect(
      republish({ relic_id: first.relic_id, path: 'notes.md' }, deps)
    ).rejects.toMatchObject({ code: 'local_state_unreadable' });
  });
});

describe('republish refusals', () => {
  test('a wrong publish token surfaces invalid_publish_token distinctly', async () => {
    writeFile('/work/notes.md', 'first');
    const first = await publish({ path: 'notes.md' }, deps);

    // The only honest road to the 403 is presenting a token the service
    // did not hash, so tamper with the stored one.
    const stored = await readStoredState();
    const entry = stored.relics[first.relic_id];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('publish state entry is missing');
    entry.publish_token = 'a-token-the-service-never-hashed';
    await writeStateFile(publishStatePath(), JSON.stringify(stored), 'utf8');

    writeFile('/work/notes.md', 'second');
    await expect(
      republish({ relic_id: first.relic_id, path: 'notes.md' }, deps)
    ).rejects.toMatchObject({ code: 'invalid_publish_token', status: 403 });

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 41,
        method: 'tools/call',
        params: {
          name: REPUBLISH_TOOL_NAME,
          arguments: { relic_id: first.relic_id, path: 'notes.md' },
        },
      },
      deps
    );
    const result = response?.result as {
      isError: boolean;
      content: { text: string }[];
      structuredContent: { code: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('invalid_publish_token');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('issued once');
    expect(text).toContain('cannot be republished from');
    expect(text).toContain('still be read');
    // Distinct from the takedown refusal, which it must never be mistaken
    // for: this relic still exists.
    expect(text).not.toContain('takedown');
  });

  test('a removed relic is terminal, and the words say so', async () => {
    writeFile('/work/notes.md', 'first');
    const first = await publish({ path: 'notes.md' }, deps);

    await app.fetch(
      new Request(`${SERVICE}/api/relics/${first.relic_id}`, {
        method: 'DELETE',
        headers: { authorization: 'Bearer operator-secret' },
      })
    );

    writeFile('/work/notes.md', 'second');
    await expect(
      republish({ relic_id: first.relic_id, path: 'notes.md' }, deps)
    ).rejects.toMatchObject({ code: 'relic_removed', status: 410 });

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 42,
        method: 'tools/call',
        params: {
          name: REPUBLISH_TOOL_NAME,
          arguments: { relic_id: first.relic_id, path: 'notes.md' },
        },
      },
      deps
    );
    const result = response?.result as {
      isError: boolean;
      content: { text: string }[];
      structuredContent: { code: string };
    };
    expect(result.isError).toBe(true);
    expect(result.structuredContent.code).toBe('relic_removed');
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('permanent');
    expect(text).toContain('cannot revive it');
    expect(text).toContain('Publish the content as a new relic');
    // The token refusal is about this machine's standing; this one is
    // about nobody's, ever again.
    expect(text).not.toContain('publish token this machine holds');
  });

  test('the key and the token never appear in tool output', async () => {
    writeFile('/work/notes.md', 'first');
    const published = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/call',
        params: { name: TOOL_NAME, arguments: { path: 'notes.md' } },
      },
      deps
    );
    const publishedResult =
      published && 'result' in published
        ? (published.result as { structuredContent: { relic_id: string } })
        : { structuredContent: { relic_id: '' } };
    const relicId = publishedResult.structuredContent.relic_id;
    const stored = await readStoredState();
    const entry = stored.relics[relicId];
    expect(entry).toBeDefined();
    if (entry === undefined) throw new Error('publish state entry is missing');

    // The publish result prints the URL, key in its fragment, by product
    // design and with its disclosure. The token has no such license.
    expect(JSON.stringify(published?.result)).not.toContain(
      entry.publish_token
    );

    // The republish result prints neither secret, and no fragment either.
    writeFile('/work/notes.md', 'second');
    const republished = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 44,
        method: 'tools/call',
        params: {
          name: REPUBLISH_TOOL_NAME,
          arguments: { relic_id: relicId, path: 'notes.md' },
        },
      },
      deps
    );
    const text = JSON.stringify(republished?.result);
    expect(text).not.toContain(entry.publish_token);
    expect(text).not.toContain(entry.key);
    expect(text).not.toContain('#r1');

    // The machine-bound refusal keeps the same discipline.
    const refused = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 45,
        method: 'tools/call',
        params: {
          name: REPUBLISH_TOOL_NAME,
          arguments: {
            relic_id: '0123456789abcdefghjkmnpqst',
            path: 'notes.md',
          },
        },
      },
      deps
    );
    const refusedText = JSON.stringify(refused?.result);
    expect(refusedText).not.toContain(entry.publish_token);
    expect(refusedText).not.toContain(entry.key);
  });
});

describe('guessMimetype', () => {
  test('maps known extensions', () => {
    expect(guessMimetype('a.md', 'markdown')).toBe('text/markdown');
    expect(guessMimetype('a.png', 'image')).toBe('image/png');
    expect(guessMimetype('a.html', 'html')).toBe('text/html');
  });

  test('declares component source as jsx, never as plain or javascript', () => {
    // text/plain and text/javascript both read as `code` in the viewer, so
    // a component published under either renders as escaped source with no
    // error. The declaration has to say jsx for the executing route to be
    // reachable at all.
    expect(guessMimetype('a.jsx', 'jsx')).toBe('text/jsx');
    expect(guessMimetype('a.tsx', 'jsx')).toBe('text/tsx');
  });

  test('falls back by class when the extension is unknown', () => {
    expect(guessMimetype('a.wat', 'code')).toBe('text/plain');
    expect(guessMimetype('noextension', 'binary')).toBe(
      'application/octet-stream'
    );
  });
});

describe('plaintext title in link previews', () => {
  test('a publish with no title argument sends the normalized filename on the grant body', async () => {
    writeFile('/work/my document.md', '# hello');
    const grants: Record<string, unknown>[] = [];

    const result = await publish(
      { path: 'my document.md' },
      { ...deps, fetch: captureGrants(grants) }
    );

    expect(grants).toHaveLength(1);
    // Asserted against the captured request body, not the result.
    expect(grants[0]?.['title']).toBe('my document.md');
    expect(result.title).toBe('my document.md');
  });

  test('an explicit title overrides the filename and is normalized', async () => {
    writeFile('/work/report.md', '# content');

    const longTitle = `Line 1\nLine 2 ${'a'.repeat(200)}`;
    const result = await publish({ path: 'report.md', title: longTitle }, deps);

    // Newline collapses to a space, and length truncates to MAX_TITLE_CHARS.
    expect(result.title).toHaveLength(MAX_TITLE_CHARS);
    expect(result.title?.startsWith('Line 1 Line 2 a')).toBe(true);
    expect(result.title).not.toContain('\n');
    expect(result.title).not.toBe(longTitle);
  });

  test('title: "" sends "" and reports title: null on both publish and republish', async () => {
    writeFile('/work/secret.md', '# confidential');
    const grants: Record<string, unknown>[] = [];

    const pubResult = await publish(
      { path: 'secret.md', title: '' },
      { ...deps, fetch: captureGrants(grants) }
    );

    expect(grants).toHaveLength(1);
    expect(grants[0]?.['title']).toBe('');
    expect(pubResult.title).toBeNull();

    const republishBodies: Record<string, unknown>[] = [];
    const uploads: string[] = [];

    // A new version needs new content: an identical one is refused before
    // it reaches the wire, and this test is about what the wire carries.
    writeFile('/work/secret.md', '# confidential, second draft');
    const repubResult = await republish(
      { relic_id: pubResult.relic_id, path: 'secret.md', title: '' },
      { ...deps, fetch: captureRepublish(republishBodies, uploads) }
    );

    expect(republishBodies).toHaveLength(1);
    expect(republishBodies[0]?.['title']).toBe('');
    expect(repubResult.title).toBeNull();
  });

  test('the publish result text names the title and how to suppress it, and the untitled result text says it went out untitled', async () => {
    writeFile('/work/notes.md', '# notes');

    // Titled publish.
    const resp1 = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'relic_publish',
          arguments: { path: 'notes.md', title: 'Important Report' },
        },
      },
      deps
    );
    const result1 = resp1?.result as {
      content: { text: string }[];
      structuredContent: { relic_id: string };
    };
    const text1 = result1.content[0]?.text ?? '';
    expect(text1).toContain(
      'The title "Important Report" is not encrypted: the service stores it and every link preview shows it. Pass an empty title to publish without one.'
    );

    // Untitled publish.
    const resp2 = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'relic_publish',
          arguments: { path: 'notes.md', title: '', force_new: true },
        },
      },
      deps
    );
    const result2 = resp2?.result as { content: { text: string }[] };
    const text2 = result2.content[0]?.text ?? '';
    expect(text2).toContain(
      'Published without a title, so a link preview shows only that it is a relic.'
    );

    // Titled republish.
    const relicId = result1.structuredContent.relic_id;
    const resp3 = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'relic_republish',
          arguments: {
            relic_id: relicId,
            path: 'notes.md',
            title: 'Updated Report',
          },
        },
      },
      deps
    );
    const result3 = resp3?.result as { content: { text: string }[] };
    const text3 = result3.content[0]?.text ?? '';
    expect(text3).toContain(
      'The title "Updated Report" is not encrypted: the service stores it and every link preview shows it. Pass an empty title to publish without one.'
    );

    // Untitled republish.
    const resp4 = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'relic_republish',
          arguments: { relic_id: relicId, path: 'notes.md', title: '' },
        },
      },
      deps
    );
    const result4 = resp4?.result as { content: { text: string }[] };
    const text4 = result4.content[0]?.text ?? '';
    expect(text4).toContain(
      'Published without a title, so a link preview shows only that it is a relic.'
    );
  });

  test('describeClient() no longer contains the string Not your filename and does say the title is stored in the clear', () => {
    const desc = describeClient(deps);
    expect(desc).not.toContain('Not your filename');
    expect(desc).toContain('stored in the clear');
  });

  test('INSTRUCTIONS carries the title fact', () => {
    expect(INSTRUCTIONS).toMatch(/plaintext title/i);
    expect(INSTRUCTIONS).toContain('A relic carries a plaintext title');
  });

  test('validates that title must be a string if provided', async () => {
    writeFile('/work/notes.md', '# notes');

    const pubResp = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'relic_publish',
          arguments: { path: 'notes.md', title: 123 },
        },
      },
      deps
    );
    expect(pubResp?.error?.code).toBe(-32602);
    expect(pubResp?.error?.message).toContain(
      '`title` must be a string or omitted'
    );

    const repubResp = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'relic_republish',
          arguments: {
            relic_id: '0123456789abcdefghjkmnpqst',
            path: 'notes.md',
            title: true,
          },
        },
      },
      deps
    );
    expect(repubResp?.error?.code).toBe(-32602);
    expect(repubResp?.error?.message).toContain(
      '`title` must be a string or omitted'
    );
  });
});
