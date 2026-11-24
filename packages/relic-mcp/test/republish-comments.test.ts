import { fetchUpload } from './upload-fixture.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { decodeKey, deriveCommentKey, encryptComment } from '@relic/format';
import { COVER_HEIGHT, COVER_WIDTH, crc32 } from '@relic/format/cover';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { APPLY_SUGGESTIONS_TOOL_NAME } from '../src/apply-suggestions.ts';
import { postComment, readComments } from '../src/comments.ts';
import { nodeFiles } from '../src/files.ts';
import {
  type PublishDeps,
  type PublishError,
  publish,
} from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import {
  handleMessage,
  READ_COMMENTS_TOOL_NAME,
  REPUBLISH_TOOL_DEFINITION,
  REPUBLISH_TOOL_NAME,
} from '../src/server.ts';
import { loadPublishState } from '../src/state.ts';
import { cachedVersionFormatPath } from '../src/suggestion-format.ts';

const SERVICE = 'https://relic.example';

let scratch: string;
let storage: MemoryStorage;
let store: MemoryStore;
let app: RelicApp;
let deps: PublishDeps;

function shimFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));

    if (url.origin === SERVICE) {
      const headers = new Headers(init?.headers);
      headers.set('x-forwarded-for', '198.51.100.10');
      return app.fetch(new Request(url.toString(), { ...init, headers }));
    }

    if (url.hostname === 'storage.invalid') {
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

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-republish-comments-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  storage = new MemoryStorage();
  store = new MemoryStore();
  app = createApp({
    storage,
    store,
  });
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: shimFetch(),
    upload: fetchUpload,
    clientName: 'relic-mcp/republish-comments-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
  callDeps: PublishDeps = deps
): Promise<Record<string, unknown>> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    callDeps
  );
  return response?.result as Record<string, unknown>;
}

function coverPng(): Uint8Array {
  const chunk = (type: string, bytes: Uint8Array): Buffer => {
    const name = Buffer.from(type, 'ascii');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
    return Buffer.concat([length, name, bytes, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(COVER_WIDTH, 0);
  header.writeUInt32BE(COVER_HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(COVER_HEIGHT * (1 + COVER_WIDTH * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function depsWithCover(): PublishDeps {
  const bytes = coverPng();
  return {
    ...deps,
    renderCover: async () => ({
      status: 'rendered',
      kind: 'markdown',
      type: 'image/png',
      bytes,
    }),
  };
}

/** Validate the JSON Schema keywords used by the republish output contract. */
function schemaErrors(schema: unknown, value: unknown, path = '$'): string[] {
  const rule = schema as Record<string, unknown>;
  const errors: string[] = [];
  const keywords = [
    'type',
    'enum',
    'minimum',
    'pattern',
    'required',
    'properties',
    'items',
    'additionalProperties',
    'description',
  ];
  for (const keyword of Object.keys(rule)) {
    if (!keywords.includes(keyword))
      errors.push(`${path}: unsupported ${keyword}`);
  }
  const expected =
    rule['type'] === undefined
      ? []
      : Array.isArray(rule['type'])
        ? rule['type']
        : [rule['type']];
  if (
    expected.length > 0 &&
    !expected.some((type) =>
      type === 'null'
        ? value === null
        : type === 'array'
          ? Array.isArray(value)
          : type === 'object'
            ? value !== null &&
              typeof value === 'object' &&
              !Array.isArray(value)
            : type === 'integer'
              ? Number.isInteger(value)
              : typeof value === type
    )
  ) {
    errors.push(`${path}: incorrect type`);
    return errors;
  }
  if (Array.isArray(rule['enum']) && !rule['enum'].includes(value))
    errors.push(`${path}: outside enum`);
  if (
    typeof rule['minimum'] === 'number' &&
    typeof value === 'number' &&
    value < rule['minimum']
  )
    errors.push(`${path}: below minimum`);
  if (
    typeof rule['pattern'] === 'string' &&
    typeof value === 'string' &&
    !new RegExp(rule['pattern']).test(value)
  )
    errors.push(`${path}: pattern mismatch`);
  if (Array.isArray(value) && rule['items'] !== undefined) {
    value.forEach((item, index) => {
      errors.push(...schemaErrors(rule['items'], item, `${path}[${index}]`));
    });
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    const properties = (rule['properties'] ?? {}) as Record<string, unknown>;
    for (const name of (rule['required'] ?? []) as string[]) {
      if (!Object.hasOwn(object, name)) errors.push(`${path}.${name}: missing`);
    }
    for (const [name, field] of Object.entries(object)) {
      if (Object.hasOwn(properties, name)) {
        errors.push(
          ...schemaErrors(properties[name], field, `${path}.${name}`)
        );
      } else if (rule['additionalProperties'] === false) {
        errors.push(`${path}.${name}: unexpected`);
      } else if (typeof rule['additionalProperties'] === 'object') {
        errors.push(
          ...schemaErrors(
            rule['additionalProperties'],
            field,
            `${path}.${name}`
          )
        );
      }
    }
  }
  return errors;
}

describe('republish comments gate', () => {
  test('a relik with no comments republishes unchanged', async () => {
    const filePath = join(scratch, 'clean.md');
    await writeFile(filePath, '# clean draft\n');
    const published = await publish({ path: filePath }, deps);

    await writeFile(filePath, '# clean draft v2\n');
    const republished = await republish(
      { relic_id: published.relic_id, path: filePath },
      deps
    );

    expect(republished.version).toBe(2);
    expect(republished.relic_id).toBe(published.relic_id);
    expect(republished.acknowledgements).toBeUndefined();
  });

  test('republish refused with one open comment, and the refusal names it', async () => {
    const filePath = join(scratch, 'report.md');
    await writeFile(filePath, '# Report v1\n');
    const published = await publish({ path: filePath }, deps);

    const state = await loadPublishState(published.relic_id);
    expect(state).toBeDefined();
    if (!state) throw new Error('state missing');
    const commentKey = await deriveCommentKey(decodeKey(state.key));

    const ciphertext = await encryptComment(commentKey, {
      body: 'Section two has an inaccurate table.',
      display_name: 'Alice',
      anchor: null,
    });

    const commentRes = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext,
        }),
      })
    );
    expect(commentRes.status).toBe(201);
    const commentData = (await commentRes.json()) as {
      comment_id: string;
      author: string;
      created_at: string;
    };

    await writeFile(filePath, '# Report v2\n');

    let thrown: PublishError | undefined;
    try {
      await republish({ relic_id: published.relic_id, path: filePath }, deps);
    } catch (error) {
      thrown = error as PublishError;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe('unaddressed_comments');
    expect(thrown?.message).toContain(
      `cannot republish relik ${published.relic_id} while comments remain unaddressed`
    );
    expect(thrown?.message).toContain(commentData.comment_id);
    expect(thrown?.message).toContain(commentData.author);
    expect(thrown?.message).toContain(commentData.created_at);
    expect(thrown?.message).toContain('Section two has an inaccurate table.');

    // Also verify via the MCP tool call interface
    const toolResult = await callTool(REPUBLISH_TOOL_NAME, {
      relic_id: published.relic_id,
      path: filePath,
    });
    expect(toolResult['isError']).toBe(true);
    const content = toolResult['content'] as Array<{
      type: string;
      text: string;
    }>;
    expect(content[0]?.text).toContain('unaddressed_comments:');
    expect(content[0]?.text).toContain(commentData.comment_id);
    expect(content[0]?.text).toContain(commentData.author);
    expect(content[0]?.text).toContain(commentData.created_at);
    expect(content[0]?.text).toContain('Section two has an inaccurate table.');
  });

  test('republish allowed once a reply carries the pointer', async () => {
    const filePath = join(scratch, 'paper.md');
    await writeFile(filePath, '# Paper v1\n');
    const published = await publish({ path: filePath }, deps);

    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('state missing');
    const commentKey = await deriveCommentKey(decodeKey(state.key));

    const ciphertext = await encryptComment(commentKey, {
      body: 'Need citation on line 12.',
      display_name: 'Peer Reviewer',
      anchor: null,
    });
    const commentRes = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext,
        }),
      })
    );
    const commentData = (await commentRes.json()) as { comment_id: string };

    await writeFile(filePath, '# Paper v2\n');

    // Attempting to republish before replying is refused
    await expect(
      republish({ relic_id: published.relic_id, path: filePath }, deps)
    ).rejects.toMatchObject({ code: 'unaddressed_comments' });

    // Reply to the comment carrying addresses
    const replyResult = await postComment(
      {
        relic_id: published.relic_id,
        body: 'Citation has been added in the bibliography.',
        addresses: commentData.comment_id,
      },
      deps
    );
    expect(replyResult.comment_id).toBeDefined();

    // Now republish is allowed without passing addresses
    const republished = await republish(
      { relic_id: published.relic_id, path: filePath },
      deps
    );
    expect(republished.version).toBe(2);

    // Verify read comments reports original comment addressed by the reply.
    // Scoped to every version: the default is the current version only, and
    // the reply predates the republish it enabled.
    const read = await readComments(published.relic_id, deps, {
      version: '*',
    });
    expect(read.summary).toEqual({
      total: 2,
      addressed: 1,
      open: 0,
      resolved: 0,
      unreadable: 0,
    });
    const c1 = read.comments.find(
      (c) => c.comment_id === commentData.comment_id
    );
    expect(c1?.addressed).toBe(true);
    expect(c1?.addressed_by?.comment_id).toBe(replyResult.comment_id);
  });

  test('republish with addresses notes posting one acknowledgement per comment, each stamped with the NEW version', async () => {
    const filePath = join(scratch, 'specs.md');
    await writeFile(filePath, '# Spec v1\n');
    const published = await publish({ path: filePath }, deps);

    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('state missing');
    const commentKey = await deriveCommentKey(decodeKey(state.key));

    // Post comment 1
    const c1Ciphertext = await encryptComment(commentKey, {
      body: 'API endpoint route has typo.',
      display_name: 'Reader 1',
      anchor: null,
    });
    const c1Res = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext: c1Ciphertext,
        }),
      })
    );
    const c1 = (await c1Res.json()) as { comment_id: string };

    // Post comment 2
    const c2Ciphertext = await encryptComment(commentKey, {
      body: 'Response code should be 201 not 200.',
      display_name: 'Reader 2',
      anchor: null,
    });
    const c2Res = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext: c2Ciphertext,
        }),
      })
    );
    const c2 = (await c2Res.json()) as { comment_id: string };

    await writeFile(filePath, '# Spec v2\n');

    // Republish acknowledging both comments
    const republished = await republish(
      {
        relic_id: published.relic_id,
        path: filePath,
        addresses: [
          {
            comment_id: c1.comment_id,
            note: 'Fixed route typo in section 4.',
          },
          {
            comment_id: c2.comment_id,
            note: 'Changed status code to 201 Created.',
          },
        ],
      },
      deps
    );

    expect(republished.version).toBe(2);
    expect(republished.acknowledgements).toBeDefined();
    expect(republished.acknowledgements).toHaveLength(2);

    // Read back all comments, on every version: the acknowledgements are
    // stamped with the new version, and the originals they answer are not.
    const read = await readComments(published.relic_id, deps, {
      version: '*',
    });
    expect(read.count).toBe(4);
    expect(read.summary).toEqual({
      total: 4,
      addressed: 2,
      open: 0,
      resolved: 0,
      unreadable: 0,
    });

    const comment1 = read.comments.find((c) => c.comment_id === c1.comment_id);
    expect(comment1?.addressed).toBe(true);
    expect(comment1?.addressed_by?.version).toBe(2);

    const comment2 = read.comments.find((c) => c.comment_id === c2.comment_id);
    expect(comment2?.addressed).toBe(true);
    expect(comment2?.addressed_by?.version).toBe(2);

    // Acknowledgements posted by the update
    const ack1 = read.comments.find((c) => c.addresses === c1.comment_id);
    expect(ack1).toBeDefined();
    expect(ack1?.body).toBe('Fixed route typo in section 4.');
    expect(comment1?.addressed_by?.comment_id).toBe(ack1?.comment_id);

    const ack2 = read.comments.find((c) => c.addresses === c2.comment_id);
    expect(ack2).toBeDefined();
    expect(ack2?.body).toBe('Changed status code to 201 Created.');
    expect(comment2?.addressed_by?.comment_id).toBe(ack2?.comment_id);

    // Verify both acknowledgements are stored with version 2 on the server
    const serverComments = await store.listComments(published.relic_id);
    const serverAck1 = serverComments.find(
      (row) => row.id === ack1?.comment_id
    );
    expect(serverAck1?.version).toBe(2);
    const serverAck2 = serverComments.find(
      (row) => row.id === ack2?.comment_id
    );
    expect(serverAck2?.version).toBe(2);
  });

  test('an empty note refused', async () => {
    const filePath = join(scratch, 'draft.md');
    await writeFile(filePath, '# Draft v1\n');
    const published = await publish({ path: filePath }, deps);

    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('state missing');
    const commentKey = await deriveCommentKey(decodeKey(state.key));
    const ciphertext = await encryptComment(commentKey, {
      body: 'Fix the typo.',
      display_name: 'Editor',
      anchor: null,
    });
    const commentRes = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext,
        }),
      })
    );
    const commentData = (await commentRes.json()) as { comment_id: string };

    await writeFile(filePath, '# Draft v2\n');

    // Whitespace-only note
    await expect(
      republish(
        {
          relic_id: published.relic_id,
          path: filePath,
          addresses: [{ comment_id: commentData.comment_id, note: '   ' }],
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'empty_acknowledgement_note' });

    // Empty string note
    await expect(
      republish(
        {
          relic_id: published.relic_id,
          path: filePath,
          addresses: [{ comment_id: commentData.comment_id, note: '' }],
        },
        deps
      )
    ).rejects.toMatchObject({ code: 'empty_acknowledgement_note' });
  });

  test('an unreadable comment blocking and reported as unreadable rather than unanswered', async () => {
    const filePath = join(scratch, 'memo.md');
    await writeFile(filePath, '# Memo v1\n');
    const published = await publish({ path: filePath }, deps);

    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('state missing');
    // Insert an unreadable comment directly (invalid ciphertext that will fail decryption)
    const badCiphertext = 'bad_ciphertext_that_cannot_decrypt';
    await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext: badCiphertext,
        }),
      })
    );

    await writeFile(filePath, '# Memo v2\n');

    let thrown: PublishError | undefined;
    try {
      await republish({ relic_id: published.relic_id, path: filePath }, deps);
    } catch (error) {
      thrown = error as PublishError;
    }

    expect(thrown).toBeDefined();
    expect(thrown?.code).toBe('unaddressed_comments');
    expect(thrown?.message).toContain('could not be decrypted');
    expect(thrown?.message).toContain('Unreadable comments (1):');
    expect(thrown?.message).toContain('unreadable');
    // Must NOT be reported under Open comments or as unanswered
    expect(thrown?.message).not.toContain('Open comments');
    expect(thrown?.message).not.toContain('unanswered');
    expect(thrown?.details).toMatchObject({
      open_count: 0,
      unreadable_count: 1,
    });
  });

  test('sealed pointer is authoritative: server-supplied clear pointer alone does not mark a comment addressed', async () => {
    const filePath = join(scratch, 'critical.md');
    await writeFile(filePath, '# Critical Spec v1\n');
    const published = await publish({ path: filePath }, deps);

    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('state missing');
    const commentKey = await deriveCommentKey(decodeKey(state.key));

    // Reader posts an authentic open comment
    const c1Ciphertext = await encryptComment(commentKey, {
      body: 'Severe security flaw in protocol flow.',
      display_name: 'Auditor',
      anchor: null,
    });
    const c1Res = await app.fetch(
      new Request(`${SERVICE}/api/relics/${published.relic_id}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: state.publish_token,
          ciphertext: c1Ciphertext,
        }),
      })
    );
    const c1 = (await c1Res.json()) as { comment_id: string };

    // An operator attempts to forge that c1 was addressed by injecting a row into
    // the server listing with a clear addresses field pointing to c1, but whose
    // encrypted ciphertext does NOT seal the addresses pointer.
    const forgedCiphertext = await encryptComment(commentKey, {
      body: 'This is not an addressed reply.',
      display_name: 'Forged',
      anchor: null,
      addresses: null, // sealed copy does NOT address c1
    });

    // Intercept comment reads on the wire to simulate an operator returning a clear
    // addresses pointer that disagrees with the sealed ciphertext.
    const wireWithClearPointer: PublishDeps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : String(input));
        if (
          url.origin === SERVICE &&
          url.pathname === `/api/relics/${published.relic_id}/comments` &&
          (!init?.method || init.method === 'GET')
        ) {
          const original = await deps.fetch(input, init);
          const rows = (await original.json()) as Record<string, unknown>[];
          // Append a forged comment carrying a clear pointer on the wire
          rows.push({
            comment_id: 'forged_reply',
            author: 'forger@example.com',
            created_at: '2026-09-17T02:00:00.000Z',
            ciphertext: forgedCiphertext,
            addresses: c1.comment_id, // Clear pointer from server
            version: 1,
          });
          return Response.json(rows);
        }
        return deps.fetch(input, init);
      }) as typeof globalThis.fetch,
    };

    // 1. Read comments over the stdio MCP harness
    const readResponse = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: READ_COMMENTS_TOOL_NAME,
          arguments: { relic_id: published.relic_id },
        },
      },
      wireWithClearPointer
    );
    const resultObj = readResponse?.result;
    expect(resultObj).toBeDefined();
    if (
      !resultObj ||
      typeof resultObj !== 'object' ||
      !('structuredContent' in resultObj)
    ) {
      throw new Error('expected structuredContent in result');
    }
    const readStructured = resultObj.structuredContent as Record<
      string,
      unknown
    >;
    const comments = readStructured['comments'] as Array<
      Record<string, unknown>
    >;
    const summary = readStructured['summary'] as Record<string, number>;
    // Neither c1 nor forged_reply carries a sealed addresses pointer,
    // so both remain open and neither is addressed.
    expect(summary['open']).toBe(2);
    expect(summary['addressed']).toBe(0);
    const c1Record = comments.find((c) => c['comment_id'] === c1.comment_id);
    expect(c1Record?.['addressed']).toBe(false);
    expect(c1Record?.['addressed_by']).toBeNull();

    // 2. Republish over the stdio MCP harness
    await writeFile(filePath, '# Critical Spec v2\n');
    const republishResponse = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: REPUBLISH_TOOL_NAME,
          arguments: {
            relic_id: published.relic_id,
            path: filePath,
          },
        },
      },
      wireWithClearPointer
    );

    // Republish MUST be refused because c1 was never addressed in sealed ciphertext
    const repubResultObj = republishResponse?.result;
    expect(repubResultObj).toBeDefined();
    if (
      !repubResultObj ||
      typeof repubResultObj !== 'object' ||
      !('isError' in repubResultObj)
    ) {
      throw new Error('expected isError in result');
    }
    const repubResult = repubResultObj as {
      isError: boolean;
      content: Array<{ text: string }>;
      structuredContent: Record<string, unknown>;
    };
    expect(repubResult.structuredContent['code']).toBe('unaddressed_comments');
    expect(repubResult.content[0]?.text).toContain('unaddressed_comments:');
    expect(repubResult.content[0]?.text).toContain(c1.comment_id);
    expect(repubResult.content[0]?.text).toContain(
      'Severe security flaw in protocol flow.'
    );
  });
});

describe('suggestions at the republish gate', () => {
  test('reader replies do not settle suggestions and outcome acknowledgements use the new version', async () => {
    const filePath = join(scratch, 'suggestions.md');
    await writeFile(filePath, '# Draft\n');
    const published = await publish({ path: filePath, cover: false }, deps);
    const state = await loadPublishState(published.relic_id);
    if (!state) throw new Error('publish state missing');
    const key = await deriveCommentKey(decodeKey(state.key));
    const createdAt = Date.parse('2026-08-20T00:00:00Z');
    await store.putComment({
      id: 'suggestion-1',
      relicId: published.relic_id,
      author: 'reader@example.com',
      createdAt,
      version: 1,
      ciphertext: await encryptComment(key, {
        body: 'Suggested edit',
        display_name: null,
        anchor: { kind: 'source', exact: 'Draft' },
        suggestion: { v: 1, mode: 'replace', replacement: 'Revised' },
      }),
    });
    await store.putComment({
      id: 'reader-reply',
      relicId: published.relic_id,
      author: 'other@example.com',
      createdAt: createdAt + 1,
      version: 1,
      ciphertext: await encryptComment(key, {
        body: 'Please consider this.',
        display_name: null,
        addresses: 'suggestion-1',
      }),
    });
    await store.putComment({
      id: 'ordinary-1',
      relicId: published.relic_id,
      author: 'reader@example.com',
      createdAt: createdAt + 2,
      version: 1,
      ciphertext: await encryptComment(key, {
        body: 'A separate note.',
        display_name: null,
      }),
    });
    const thread = await readComments(published.relic_id, deps, {
      version: '*',
    });
    expect(thread.summary.open).toBe(2);
    expect(thread.comments[0]).toMatchObject({
      suggestion_state: 'pending',
      addressed: false,
    });
    await writeFile(filePath, '# Revised\n');

    let writes = 0;
    const trackingDeps: PublishDeps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (
          url.pathname.endsWith('/republish') ||
          (url.pathname.endsWith('/comments') && init?.method === 'POST')
        )
          writes++;
        return deps.fetch(input, init);
      }) as typeof fetch,
    };
    await expect(
      republish(
        { relic_id: published.relic_id, path: filePath, cover: false },
        trackingDeps
      )
    ).rejects.toMatchObject({ code: 'unaddressed_comments' });
    await expect(
      republish(
        {
          relic_id: published.relic_id,
          path: filePath,
          cover: false,
          addresses: [{ comment_id: 'suggestion-1', note: 'Applied.' }],
        },
        trackingDeps
      )
    ).rejects.toMatchObject({ code: 'suggestion_outcome_required' });
    await expect(
      republish(
        {
          relic_id: published.relic_id,
          path: filePath,
          cover: false,
          addresses: [
            { comment_id: 'ordinary-1', note: 'Done.', outcome: 'accepted' },
          ],
        },
        trackingDeps
      )
    ).rejects.toMatchObject({ code: 'outcome_not_applicable' });
    expect(writes).toBe(0);

    const result = await republish(
      {
        relic_id: published.relic_id,
        path: filePath,
        cover: false,
        addresses: [
          { comment_id: 'suggestion-1', note: 'Applied.', outcome: 'accepted' },
          { comment_id: 'ordinary-1', note: 'Considered.' },
        ],
      },
      trackingDeps
    );
    expect(result.version).toBe(2);
    const read = await readComments(published.relic_id, deps, { version: '*' });
    const suggestion = read.comments.find(
      (row) => row.comment_id === 'suggestion-1'
    );
    expect(suggestion).toMatchObject({
      suggestion_state: 'accepted',
      suggestion_answer: { version: 2, outcome: 'accepted' },
    });
    const acknowledgement = read.comments.find(
      (row) => row.suggestion_outcome === 'accepted'
    );
    expect(acknowledgement).toMatchObject({
      author: 'publisher',
      version: 2,
      addresses: 'suggestion-1',
    });
    expect(read.summary.open).toBe(0);
  });
});

describe('republish suggestion format history', () => {
  test('preserves a legacy file format and previews an old suggestion without minting', async () => {
    const filePath = join(scratch, 'notes.md');
    await writeFile(filePath, '# Draft\n');
    const published = await publish({ path: filePath, cover: false }, deps);
    const initial = await loadPublishState(published.relic_id);
    if (!initial) throw new Error('publish state missing');
    const key = await deriveCommentKey(decodeKey(initial.key));

    const statePath = join(scratch, 'publish-state.json');
    const raw = JSON.parse(await readFile(statePath, 'utf8')) as {
      relics: Record<string, Record<string, unknown>>;
    };
    const legacy = raw.relics[published.relic_id];
    if (!legacy) throw new Error('publish state missing');
    delete legacy['version_formats'];
    delete legacy['shape'];
    await writeFile(statePath, `${JSON.stringify(raw, null, 2)}\n`);

    await store.putComment({
      id: 'legacy-suggestion',
      relicId: published.relic_id,
      author: 'reader@example.com',
      createdAt: Date.parse('2026-08-20T00:00:00Z'),
      version: 1,
      ciphertext: await encryptComment(key, {
        body: 'Revise the title.',
        display_name: null,
        anchor: { kind: 'source', exact: 'Draft' },
        suggestion: { v: 1, mode: 'replace', replacement: 'Revised' },
      }),
    });
    await writeFile(filePath, '# Draft\n\nAdded detail.\n');
    const result = await republish(
      {
        relic_id: published.relic_id,
        path: filePath,
        filename: 'notes.markdown',
        addresses: [
          {
            comment_id: 'legacy-suggestion',
            note: 'Saved for a later revision.',
            outcome: 'deferred',
          },
        ],
      },
      depsWithCover()
    );
    expect(result.version).toBe(2);
    expect(result.cover.status).toBe('uploaded');
    expect(result.warnings).toBeUndefined();
    const state = await loadPublishState(published.relic_id);
    expect(state?.cover_uploaded).toBe(true);
    expect(state?.version_formats).toEqual({
      '1': { shape: 'file', extension: 'md' },
      '2': { shape: 'file', extension: 'markdown' },
    });

    let mints = 0;
    const trackingDeps: PublishDeps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname.endsWith('/mint')) mints++;
        return deps.fetch(input, init);
      }) as typeof fetch,
    };
    const preview = await callTool(
      APPLY_SUGGESTIONS_TOOL_NAME,
      {
        relic_id: published.relic_id,
        path: filePath,
        accept: ['legacy-suggestion'],
      },
      trackingDeps
    );
    expect(preview['isError']).toBe(false);
    expect(preview['structuredContent']).toMatchObject({
      written: false,
      applied: [{ comment_id: 'legacy-suggestion', line: 1, end_line: 1 }],
    });
    expect(mints).toBe(0);
    expect(await readFile(filePath, 'utf8')).toBe('# Draft\n\nAdded detail.\n');
  });

  test('reports a damaged folder cache through MCP and still uploads the cover and acknowledgements', async () => {
    const folder = join(scratch, 'docs');
    const filePath = join(folder, 'a.md');
    await mkdir(folder);
    await writeFile(filePath, '# Draft\n');
    const published = await publish({ path: folder, cover: false }, deps);
    const initial = await loadPublishState(published.relic_id);
    if (!initial) throw new Error('publish state missing');
    const key = await deriveCommentKey(decodeKey(initial.key));
    for (const [id, body] of [
      ['folder-comment-1', 'Review the first section.'],
      ['folder-comment-2', 'Review the second section.'],
    ] as const) {
      await store.putComment({
        id,
        relicId: published.relic_id,
        author: 'reader@example.com',
        createdAt: Date.parse('2026-08-20T00:00:00Z'),
        version: 1,
        ciphertext: await encryptComment(key, {
          body,
          display_name: null,
          entry: 'a.md',
        }),
      });
    }
    await writeFile(filePath, '# Revised\n');
    const cachePath = cachedVersionFormatPath(published.relic_id, 2);
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, 'damaged');

    const response = await callTool(
      REPUBLISH_TOOL_NAME,
      {
        relic_id: published.relic_id,
        path: folder,
        addresses: [
          {
            comment_id: 'folder-comment-1',
            note: 'Updated the first section.',
          },
          {
            comment_id: 'folder-comment-2',
            note: 'Updated the second section.',
          },
        ],
      },
      depsWithCover()
    );
    expect(response['isError']).toBe(false);
    const result = response['structuredContent'] as {
      version: number;
      acknowledgements: unknown[];
      cover: { status: string };
      warnings: { code: string; message: string }[];
    };
    expect(result.version).toBe(2);
    expect(result.acknowledgements).toHaveLength(2);
    expect(
      schemaErrors(REPUBLISH_TOOL_DEFINITION.outputSchema, result)
    ).toEqual([]);
    const missingUrl = { ...result } as Record<string, unknown>;
    delete missingUrl['report_url'];
    expect(
      schemaErrors(REPUBLISH_TOOL_DEFINITION.outputSchema, missingUrl)
    ).toContain('$.report_url: missing');
    const invalidWarning = {
      ...result,
      warnings: [{ ...result.warnings[0], unexpected: true }],
    };
    expect(
      schemaErrors(REPUBLISH_TOOL_DEFINITION.outputSchema, invalidWarning)
    ).toContain('$.warnings[0].unexpected: unexpected');
    expect(result.cover.status).toBe('uploaded');
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      code: 'suggestion_format_cache_failed',
    });
    expect(result.warnings[0]?.message).toContain('Version 2 is live');
    expect(result.warnings[0]?.message).toContain('corrupt');
    const content = response['content'] as { text: string }[];
    expect(content[0]?.text).toContain('suggestion_format_cache_failed');
    expect(content[0]?.text).toContain(result.warnings[0]!.message);
    expect(REPUBLISH_TOOL_DEFINITION.outputSchema.properties.warnings).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { code: { type: 'string' }, message: { type: 'string' } },
        required: ['code', 'message'],
        additionalProperties: false,
      },
    });
    expect(await readFile(cachePath, 'utf8')).toBe('damaged');
    const state = await loadPublishState(published.relic_id);
    expect(state?.version).toBe(2);
    expect(state?.cover_uploaded).toBe(true);
    expect(state?.version_formats).toEqual({
      '1': { shape: 'folder' },
      '2': { shape: 'folder' },
    });
    expect((await store.getRelic(published.relic_id))?.cover?.version).toBe(2);
    const thread = await readComments(published.relic_id, deps, {
      version: '*',
    });
    for (const id of ['folder-comment-1', 'folder-comment-2']) {
      expect(
        thread.comments.find((row) => row.comment_id === id)
      ).toMatchObject({
        addressed: true,
        addressed_by: { version: 2 },
      });
    }

    await store.putComment({
      id: 'version-2-suggestion',
      relicId: published.relic_id,
      author: 'reader@example.com',
      createdAt: Date.parse('2026-08-21T00:00:00Z'),
      version: 2,
      ciphertext: await encryptComment(key, {
        body: 'Revise the heading.',
        display_name: null,
        entry: 'a.md',
        anchor: { kind: 'source', exact: 'Revised' },
        suggestion: { v: 1, mode: 'replace', replacement: 'Final' },
      }),
    });
    let mints = 0;
    const trackingDeps: PublishDeps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(String(input)).pathname.endsWith('/mint')) mints++;
        return deps.fetch(input, init);
      }) as typeof fetch,
    };
    const refused = await callTool(
      APPLY_SUGGESTIONS_TOOL_NAME,
      {
        relic_id: published.relic_id,
        path: folder,
        accept: ['version-2-suggestion'],
        write: true,
      },
      trackingDeps
    );
    expect(refused['isError']).toBe(true);
    expect(refused['structuredContent']).toMatchObject({
      code: 'suggestion_source_format_unavailable',
      version: 2,
      reason: 'Error: The suggestion format cache is corrupt.',
    });
    expect(mints).toBe(0);
    expect(await readFile(cachePath, 'utf8')).toBe('damaged');
    expect(await readFile(filePath, 'utf8')).toBe('# Revised\n');
  });
});
