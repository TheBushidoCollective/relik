import { fetchUpload } from './upload-fixture.ts';
/**
 * Version scoping on the comment read, and the comment state it carries.
 *
 * The reason this exists: an agent reading a republished relic was handed
 * remarks about content that no longer exists, and could not tell. The
 * default now resolves the relic's current version from the service and
 * returns only that version's comments; every other scope is explicit. The
 * republish gate must keep reading every version, because a remark left
 * unanswered on version 1 still blocks, and a resolved comment counts as
 * handled.
 *
 * The service is a stub in the style of `comments.test.ts`: rows with
 * service-minted ids, versions, and the clear state fields; the bodies are
 * sealed under the comment key this machine derives from local publish
 * state.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CommentAnchor,
  decodeKey,
  decryptComment,
  deriveCommentKey,
  encryptComment,
} from '@relic/format';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import {
  EDIT_COMMENT_TOOL_NAME,
  handleMessage,
  READ_COMMENTS_TOOL_NAME,
  REPUBLISH_TOOL_DEFINITION,
  RESOLVE_COMMENT_TOOL_NAME,
} from '../src/server.ts';
import { publishStatePath } from '../src/state.ts';

const SERVICE = 'https://relic.example';

interface StubCommentRow {
  comment_id: string;
  author: string;
  created_at: string;
  ciphertext: string;
  version: number | null;
  edited_at?: string | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
}

let scratch: string;
let deps: PublishDeps;
let stored: StubCommentRow[];
let refuseMint: { status: number; body: Record<string, unknown> } | null;
let currentVersionForRelic: number | null;
let patched: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-comment-scope-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  stored = [];
  refuseMint = null;
  currentVersionForRelic = 1;
  patched = [];
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: scopeFetch(),
    upload: fetchUpload,
    clientName: 'relic-mcp/comment-scope-test',
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

function scopeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));

    if (url.hostname === 'storage.invalid' && init?.method === 'PUT') {
      return new Response(null, { status: 200 });
    }

    if (url.pathname.match(/\/api\/relics\/[^/]+\/mint$/)) {
      if (refuseMint !== null) {
        return Response.json(refuseMint.body, { status: refuseMint.status });
      }
      return Response.json({
        url: `https://storage.invalid/download/current`,
        object_length: 0,
        version: currentVersionForRelic,
        current_version: currentVersionForRelic,
      });
    }
    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'comment-challenge',
        size_limit_bytes: 10_000_000,
        size_basis: 'plaintext',
      });
    }
    if (url.pathname === '/api/grant') {
      return Response.json({
        publish_token: 'publish-token-held-only-in-local-state',
        upload_url: 'https://storage.invalid/upload/first',
        relic_expires_at: null,
        report_url: `${SERVICE}/abuse`,
        disclosure_url: `${SERVICE}/disclosure`,
      });
    }
    if (url.pathname.match(/\/api\/relics\/[^/]+\/republish$/)) {
      return Response.json({
        upload_url: 'https://storage.invalid/upload/next',
        relic_expires_at: null,
        report_url: `${SERVICE}/abuse`,
        disclosure_url: `${SERVICE}/disclosure`,
      });
    }
    if (url.pathname.endsWith('/complete')) return Response.json({});

    if (url.pathname.endsWith('/comments')) {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        stored.push({
          comment_id: `c${stored.length + 1}`,
          author: 'publisher',
          created_at: `2026-08-20T0${stored.length}:00:00Z`,
          ciphertext: String(body['ciphertext']),
          version: currentVersionForRelic,
        });
        return Response.json({
          comment_id: stored[stored.length - 1]?.comment_id,
          author: 'publisher',
          created_at: stored[stored.length - 1]?.created_at,
        });
      }
      return Response.json(stored);
    }

    const commentMatch = url.pathname.match(/\/comments\/([^/]+)$/);
    if (commentMatch !== null && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patched.push({ url: url.pathname, body });
      return Response.json({
        comment_id: decodeURIComponent(commentMatch[1] ?? ''),
        author: 'publisher',
        created_at: '2026-08-20T00:00:00Z',
        edited_at:
          body['ciphertext'] !== undefined ? '2026-09-20T10:00:00Z' : null,
        resolved_at: body['resolved'] === true ? '2026-09-20T11:00:00Z' : null,
        resolved_by: body['resolved'] === true ? 'publisher' : null,
      });
    }

    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    deps
  );
  return response?.result as Record<string, unknown>;
}

/** Publish a throwaway file so this machine holds a key and a token. */
async function publishFixture(): Promise<string> {
  const path = join(scratch, 'report.md');
  await writeFile(path, '# under review\n');
  const result = await publish({ path }, deps);
  return result.relic_id;
}

async function storedKey(relicId: string): Promise<string> {
  const file = JSON.parse(await readFile(publishStatePath(), 'utf8')) as {
    relics: Record<string, { key: string }>;
  };
  const entry = file.relics[relicId];
  if (entry === undefined) throw new Error(`no state for ${relicId}`);
  return entry.key;
}

/** Seal a comment row with the given plaintext, under the relic's comment key. */
async function sealComment(
  key: string,
  comment: {
    body: string;
    display_name?: string;
    anchor?: CommentAnchor;
    addresses?: string;
  }
): Promise<string> {
  const commentKey = await deriveCommentKey(decodeKey(key));
  return encryptComment(commentKey, {
    body: comment.body,
    display_name: comment.display_name ?? null,
    ...(comment.anchor == null ? {} : { anchor: comment.anchor }),
    ...(comment.addresses == null ? {} : { addresses: comment.addresses }),
  });
}

/** Seed one comment into the stub's store, sealed under the relic's key. */
async function seedComment(
  relicId: string,
  row: Omit<StubCommentRow, 'ciphertext'> & {
    body: string;
    display_name?: string;
    anchor?: CommentAnchor;
    addresses?: string;
  }
): Promise<void> {
  const key = await storedKey(relicId);
  const ciphertext = await sealComment(key, row);
  stored.push({
    comment_id: row.comment_id,
    author: row.author,
    created_at: row.created_at,
    ciphertext,
    version: row.version ?? null,
    edited_at: row.edited_at ?? null,
    resolved_at: row.resolved_at ?? null,
    resolved_by: row.resolved_by ?? null,
  });
}

function structured(result: Record<string, unknown>): {
  [key: string]: unknown;
} {
  return result['structuredContent'] as Record<string, unknown>;
}

describe('version scoping on relic_read_comments', () => {
  test('the default returns only the current version, and says what it left out', async () => {
    const relicId = await publishFixture();
    currentVersionForRelic = 3;
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'remark on version one',
    });
    await seedComment(relicId, {
      comment_id: 'c2',
      author: 'reader@example.com',
      created_at: '2026-08-20T01:00:00Z',
      version: 2,
      body: 'remark on version two',
    });
    await seedComment(relicId, {
      comment_id: 'c3',
      author: 'reader@example.com',
      created_at: '2026-08-20T02:00:00Z',
      version: 3,
      body: 'remark on version three',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(result['isError']).toBe(false);
    const data = structured(result);
    expect(data['version_scope']).toBe(3);
    expect(data['current_version']).toBe(3);
    expect(data['count']).toBe(1);
    expect(data['hidden_by_scope']).toBe(2);
    const comments = data['comments'] as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);
    expect(comments[0]?.['comment_id']).toBe('c3');
    expect(comments[0]?.['version']).toBe(3);
  });

  test('an explicit version returns the comments made on that version', async () => {
    const relicId = await publishFixture();
    currentVersionForRelic = 3;
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'version one remark',
    });
    await seedComment(relicId, {
      comment_id: 'c2',
      author: 'reader@example.com',
      created_at: '2026-08-20T01:00:00Z',
      version: 2,
      body: 'version two remark',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
      version: 2,
    });
    expect(result['isError']).toBe(false);
    const data = structured(result);
    expect(data['version_scope']).toBe(2);
    expect(data['current_version']).toBe(null);
    expect(data['count']).toBe(1);
    const comments = data['comments'] as Array<Record<string, unknown>>;
    expect(comments[0]?.['comment_id']).toBe('c2');
  });

  test('"*" returns every comment on every version', async () => {
    const relicId = await publishFixture();
    currentVersionForRelic = 3;
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'version one remark',
    });
    await seedComment(relicId, {
      comment_id: 'c2',
      author: 'reader@example.com',
      created_at: '2026-08-20T01:00:00Z',
      version: 3,
      body: 'version three remark',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
      version: '*',
    });
    expect(result['isError']).toBe(false);
    const data = structured(result);
    expect(data['version_scope']).toBe('all');
    expect(data['count']).toBe(2);
    expect(data['hidden_by_scope']).toBe(0);
  });

  test('a row carrying no version belongs to version 1 and is hidden from the current version when history exists', async () => {
    // The rule mirrored from the viewer's thread filter
    // (packages/relic-viewer/src/main.ts 4577-4597): with history, a row
    // carrying no version shows on version 1 only.
    const relicId = await publishFixture();
    currentVersionForRelic = 2;
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: null,
      body: 'pre-versioning remark',
    });

    // Default (current, version 2): the unversioned row is hidden, not lost.
    const current = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(structured(current)['count']).toBe(0);
    expect(structured(current)['hidden_by_scope']).toBe(1);

    // Version 1 explicitly: it shows.
    const first = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
      version: 1,
    });
    const firstComments = structured(first)['comments'] as Array<
      Record<string, unknown>
    >;
    expect(firstComments).toHaveLength(1);
    expect(firstComments[0]?.['comment_id']).toBe('c1');
  });

  test('a relic with no history shows every row regardless of stored version', async () => {
    // Mirrors the viewer rule's first clause: no history, no version
    // dimension, so a single-version relic never loses rows.
    const relicId = await publishFixture();
    currentVersionForRelic = 1;
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: null,
      body: 'unversioned remark',
    });
    await seedComment(relicId, {
      comment_id: 'c2',
      author: 'reader@example.com',
      created_at: '2026-08-20T01:00:00Z',
      version: 1,
      body: 'version one remark',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(result['isError']).toBe(false);
    const data = structured(result);
    expect(data['version_scope']).toBe(1);
    expect(data['count']).toBe(2);
    expect(data['hidden_by_scope']).toBe(0);
  });

  test('hidden_by_scope counts the comments the scope did not return', async () => {
    const relicId = await publishFixture();
    currentVersionForRelic = 4;
    for (let version = 1; version <= 3; version++) {
      await seedComment(relicId, {
        comment_id: `c${version}`,
        author: 'reader@example.com',
        created_at: `2026-08-20T0${version}:00:00Z`,
        version,
        body: `version ${version} remark`,
      });
    }

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
      version: 2,
    });
    const data = structured(result);
    expect(data['count']).toBe(1);
    expect(data['hidden_by_scope']).toBe(2);

    const transcript = JSON.stringify(result['content']);
    expect(transcript).toContain('2 comment(s) exist outside this scope');
  });

  test('a failed current-version read refuses rather than defaulting', async () => {
    const relicId = await publishFixture();
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'remark',
    });
    refuseMint = { status: 503, body: { code: 'service_paused' } };

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(result['isError']).toBe(true);
    expect(structured(result)['code']).toBe('current_version_unavailable');
  });

  test('an invalid version argument is refused at the tool boundary', async () => {
    const relicId = await publishFixture();
    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: READ_COMMENTS_TOOL_NAME,
          arguments: { relic_id: relicId, version: 0 },
        },
      },
      deps
    );
    const error = response?.error as { message?: string } | undefined;
    expect(error?.message).toContain(
      '`version` must be a positive version number'
    );
  });
});

describe('the republish gate under version scoping', () => {
  test('an unanswered comment on an old version still blocks a republish', async () => {
    const relicId = await publishFixture();
    currentVersionForRelic = 2;
    // Unanswered, on version 1. The newer default would hide it; the gate
    // must read every version or this relic would silently republish over
    // an objection nobody answered.
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'section two has an inaccurate table',
    });

    const filePath = join(scratch, 'report.md');
    await writeFile(filePath, '# report v2\n');

    let refused: { code?: string; message?: string } | undefined;
    try {
      await republish({ relic_id: relicId, path: filePath }, deps);
    } catch (error) {
      refused = error as { code?: string; message?: string };
    }
    expect(refused?.code).toBe('unaddressed_comments');
    expect(refused?.message).toContain('relic_resolve_comment');
  });

  test('a resolved comment no longer blocks a republish', async () => {
    const relicId = await publishFixture();
    currentVersionForRelic = 2;
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'section two has an inaccurate table',
      resolved_at: '2026-09-19T09:00:00Z',
      resolved_by: 'reader@example.com',
    });

    const filePath = join(scratch, 'report.md');
    await writeFile(filePath, '# report v2\n');
    const republished = await republish(
      { relic_id: relicId, path: filePath },
      deps
    );
    expect(republished.version).toBe(2);
  });

  test('the republish tool description says the gate reads every version', () => {
    // The tool list carries the same fact the gate enforces. If the gate's
    // scope ever drifts, this sentence and the code disagree in a way an
    // agent reading the surface can see.
    expect(REPUBLISH_TOOL_DEFINITION.description).toContain('every version');
  });
});

describe('editing and resolving comments', () => {
  test('relic_edit_comment re-seals the body and carries the anchor and addresses forward', async () => {
    const relicId = await publishFixture();
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'publisher',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'the table in section two is wrong',
      addresses: 'c0',
    });
    const anchor: CommentAnchor = {
      kind: 'quote',
      exact: 'the table',
      prefix: 'in ',
      suffix: ' below',
    };
    await seedComment(relicId, {
      comment_id: 'c2',
      author: 'publisher',
      created_at: '2026-08-20T01:00:00Z',
      version: 1,
      body: 'the table in section two is right',
      anchor,
      addresses: 'c1',
    });

    const result = await callTool(EDIT_COMMENT_TOOL_NAME, {
      relic_id: relicId,
      comment_id: 'c2',
      body: 'the table in section two was corrected',
    });
    expect(result['isError']).toBe(false);

    // The write went to the comment's own URL as a PATCH, with the token
    // in the body and exactly the ciphertext, never the plaintext.
    expect(patched).toHaveLength(1);
    expect(patched[0]?.url).toContain(`/api/relics/${relicId}/comments/c2`);
    const patchBody = patched[0]?.body ?? {};
    expect(typeof patchBody['publish_token']).toBe('string');
    expect(typeof patchBody['ciphertext']).toBe('string');
    expect(patchBody['resolved']).toBeUndefined();

    // Re-seal means re-seal: the anchor and the addresses pointer are the
    // originals, and only the words changed.
    const key = await storedKey(relicId);
    const opened = await decryptComment(
      await deriveCommentKey(decodeKey(key)),
      String(patchBody['ciphertext'])
    );
    expect(opened.body).toBe('the table in section two was corrected');
    expect(opened.anchor).toEqual(anchor);
    expect(opened.addresses).toBe('c1');

    const data = structured(result);
    expect(data['comment_id']).toBe('c2');
    expect(data['edited_at']).toBe('2026-09-20T10:00:00Z');
  });

  test('editing an HTML image comment preserves its encrypted locator', async () => {
    const relicId = await publishFixture();
    const anchor: CommentAnchor = {
      kind: 'image',
      path: [
        { tag: 'main', index: 0 },
        { tag: 'img', index: 1 },
      ],
      source_sha256: 'a'.repeat(64),
    };
    await seedComment(relicId, {
      comment_id: 'c1',
      author: 'publisher',
      created_at: '2026-08-20T00:00:00Z',
      version: 1,
      body: 'Original image comment',
      anchor,
      addresses: 'c0',
    });
    const result = await callTool(EDIT_COMMENT_TOOL_NAME, {
      relic_id: relicId,
      comment_id: 'c1',
      body: 'Revised image comment',
    });
    expect(result['isError']).toBe(false);
    expect(patched).toHaveLength(1);
    const body = patched[0]?.body ?? {};
    expect(JSON.stringify(body)).not.toContain(anchor.source_sha256);
    const opened = await decryptComment(
      await deriveCommentKey(decodeKey(await storedKey(relicId))),
      String(body['ciphertext'])
    );
    expect(opened.body).toBe('Revised image comment');
    expect(opened.anchor).toEqual(anchor);
    expect(opened.addresses).toBe('c0');
  });

  test('relic_edit_comment refuses a comment this machine cannot read', async () => {
    const relicId = await publishFixture();
    stored.push({
      comment_id: 'c1',
      author: 'publisher',
      created_at: '2026-08-20T00:00:00Z',
      ciphertext: 'not-a-sealed-comment',
      version: 1,
    });

    const result = await callTool(EDIT_COMMENT_TOOL_NAME, {
      relic_id: relicId,
      comment_id: 'c1',
      body: 'revised words',
    });
    expect(result['isError']).toBe(true);
    expect(structured(result)['code']).toBe('local_comment_unreadable');
    expect(patched).toHaveLength(0);
  });

  test('relic_edit_comment refuses a comment that does not exist', async () => {
    const relicId = await publishFixture();
    const result = await callTool(EDIT_COMMENT_TOOL_NAME, {
      relic_id: relicId,
      comment_id: 'c9',
      body: 'revised words',
    });
    expect(result['isError']).toBe(true);
    expect(structured(result)['code']).toBe('local_comment_not_found');
  });

  test('relic_resolve_comment sets the resolution through the patch endpoint', async () => {
    const relicId = await publishFixture();
    const result = await callTool(RESOLVE_COMMENT_TOOL_NAME, {
      relic_id: relicId,
      comment_id: 'c1',
      resolved: true,
    });
    expect(result['isError']).toBe(false);
    expect(patched).toHaveLength(1);
    expect(patched[0]?.url).toContain('/api/relics/');
    expect(patched[0]?.url).toContain('/comments/c1');
    expect(patched[0]?.body['resolved']).toBe(true);
    expect(patched[0]?.body['ciphertext']).toBeUndefined();

    const data = structured(result);
    expect(data['resolved_at']).toBe('2026-09-20T11:00:00Z');
    expect(data['resolved_by']).toBe('publisher');
  });

  test('relic_resolve_comment clears the resolution with false', async () => {
    const relicId = await publishFixture();
    const result = await callTool(RESOLVE_COMMENT_TOOL_NAME, {
      relic_id: relicId,
      comment_id: 'c1',
      resolved: false,
    });
    expect(result['isError']).toBe(false);
    expect(patched[0]?.body['resolved']).toBe(false);

    const transcript = JSON.stringify(result['content']);
    expect(transcript).toContain('open again');
  });
});
