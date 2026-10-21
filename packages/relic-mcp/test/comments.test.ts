import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMMENT_NONCE_BYTES,
  decodeKey,
  decryptComment,
  deriveCommentKey,
  encryptComment,
  generateKey,
} from '@relic/format';
import {
  boxPosition,
  describeAnchor,
  formatTimecode,
  parseTimecode,
} from '../src/comments.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import {
  probeFfmpeg,
  resetFfmpegCacheForTest,
  runFfmpeg,
} from '../src/resolve-anchor.ts';
import {
  COMMENT_TOOL_NAME,
  handleMessage,
  READ_COMMENTS_TOOL_NAME,
} from '../src/server.ts';
import { publishStatePath } from '../src/state.ts';

const SERVICE = 'https://relic.example';

interface CommentRow {
  comment_id: string;
  author: string;
  created_at: string;
  ciphertext: string;
}

let scratch: string;
let deps: PublishDeps;
let stored: CommentRow[];
let posted: Record<string, unknown>[];
let refuseComments: { status: number; body: Record<string, unknown> } | null;
let uploadedContainers: Map<string, Uint8Array>;
let mintFetchCount: number;
let containerDownloadCount: number;
let refuseMint: { status: number; body: Record<string, unknown> } | null;
/**
 * The relic's current version the stub mint reports. Default 1; a test that
 * needs a multi-version relic sets it, because a real republish increments
 * the row and this stub stands in for the service's ledger.
 */
let currentVersionForRelic: number | null;
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-comments-'));
  process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'publish-state.json');
  stored = [];
  posted = [];
  refuseComments = null;
  uploadedContainers = new Map();
  mintFetchCount = 0;
  containerDownloadCount = 0;
  refuseMint = null;
  currentVersionForRelic = null;
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: commentFetch(),
    clientName: 'relic-mcp/comments-test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
});

/**
 * A service that behaves like the real one on the two members that matter
 * here: it never sees a plaintext body, and it attributes a token-authorized
 * comment to `publisher`.
 */
function commentFetch(): typeof globalThis.fetch {
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
        uploadedContainers.set(url.pathname, bodyBytes);
      }
      return new Response(null, { status: 200 });
    }

    if (
      url.hostname === 'storage.invalid' &&
      (!init?.method || init?.method === 'GET')
    ) {
      containerDownloadCount++;
      const id = url.pathname.replace(/^\/download\//, '');
      const bytes =
        uploadedContainers.get(id) ??
        uploadedContainers.get(url.pathname) ??
        uploadedContainers.get('first') ??
        uploadedContainers.get('/upload/first') ??
        new Uint8Array(0);
      return new Response(Buffer.from(bytes), {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    }

    if (url.pathname.match(/\/api\/relics\/[^/]+\/mint$/)) {
      mintFetchCount++;
      if (refuseMint !== null) {
        return Response.json(refuseMint.body, { status: refuseMint.status });
      }
      const match = url.pathname.match(/\/api\/relics\/([^/]+)\/mint$/);
      const relicId = match?.[1] ?? 'first';
      const bytes =
        uploadedContainers.get(relicId) ??
        uploadedContainers.get('first') ??
        uploadedContainers.get('/upload/first') ??
        new Uint8Array(0);
      return Response.json({
        url: `https://storage.invalid/download/${relicId}`,
        object_length: bytes.length,
        version: 1,
        current_version: currentVersionForRelic ?? 1,
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
      let relicId = 'first';
      if (init?.body) {
        try {
          const parsed = JSON.parse(String(init.body)) as { relic_id?: string };
          if (parsed.relic_id) relicId = parsed.relic_id;
        } catch {
          // Default to 'first' if body is not JSON
        }
      }
      return Response.json({
        publish_token: 'publish-token-held-only-in-local-state',
        upload_url: `https://storage.invalid/upload/${relicId}`,
        relic_expires_at: null,
        report_url: `${SERVICE}/abuse`,
        disclosure_url: `${SERVICE}/disclosure`,
      });
    }
    if (url.pathname.endsWith('/complete')) return Response.json({});

    if (url.pathname.endsWith('/comments')) {
      if (refuseComments !== null) {
        return Response.json(refuseComments.body, {
          status: refuseComments.status,
        });
      }
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posted.push(body);
        const row = {
          comment_id: `c${stored.length + 1}`,
          author: 'publisher',
          created_at: `2026-08-20T0${stored.length}:00:00Z`,
          ciphertext: String(body['ciphertext']),
          // The service stamps every comment with the relic's current
          // version at post time; the stub mirrors that.
          version: currentVersionForRelic ?? 1,
        };
        stored.push(row);
        return Response.json({
          comment_id: row.comment_id,
          author: row.author,
          created_at: row.created_at,
        });
      }
      return Response.json(stored);
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

/** Seal arbitrary JSON under a comment key to simulate a newer writer. */
async function sealRawComment(key: CryptoKey, json: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(COMMENT_NONCE_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce.slice().buffer as ArrayBuffer },
      key,
      new TextEncoder().encode(json).slice().buffer as ArrayBuffer
    )
  );
  const framed = new Uint8Array(nonce.length + sealed.length);
  framed.set(nonce, 0);
  framed.set(sealed, nonce.length);
  return Buffer.from(framed).toString('base64url');
}

describe('writing a comment as the publisher', () => {
  test('sends ciphertext plus the stored token, never the body', async () => {
    const relicId = await publishFixture();

    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'The second chart is using last quarter numbers.',
      display_name: 'Relic Agent',
    });

    expect(result['isError']).toBe(false);
    expect(result['structuredContent']).toEqual({
      relic_id: relicId,
      comment_id: 'c1',
      author: 'publisher',
      created_at: '2026-08-20T00:00:00Z',
    });

    const request = posted[0];
    expect(request).toBeDefined();
    expect(Object.hasOwn(request ?? {}, 'version')).toBe(false);
    expect(request?.['publish_token']).toBe(
      'publish-token-held-only-in-local-state'
    );
    const ciphertext = String(request?.['ciphertext']);
    expect(ciphertext).not.toContain('second chart');
    expect(JSON.stringify(request)).not.toContain('last quarter');
    // The only party who can read it is somebody holding the relic key.
    const commentKey = await deriveCommentKey(
      decodeKey(await storedKey(relicId))
    );
    expect(await decryptComment(commentKey, ciphertext)).toEqual({
      body: 'The second chart is using last quarter numbers.',
      display_name: 'Relic Agent',
      anchor: null,
      addresses: null,
    });
  });

  test('refuses an empty body and one over the envelope cap', async () => {
    const relicId = await publishFixture();

    const empty = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: '   ',
    });
    expect(empty['isError']).toBe(true);
    expect(
      (empty['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_body_empty');

    const long = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'x'.repeat(4097),
    });
    expect(long['isError']).toBe(true);
    const details = long['structuredContent'] as Record<string, unknown>;
    expect(details['code']).toBe('local_comment_body_too_long');
    expect(details['body_bytes']).toBe(4097);
    expect(posted).toHaveLength(0);
  });

  test('names a comment rate limit as something to wait out', async () => {
    const relicId = await publishFixture();
    refuseComments = {
      status: 429,
      body: { code: 'comment_rate_limited', retry_after_seconds: 30 },
    };

    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'One more thought.',
    });

    expect(result['isError']).toBe(true);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('comment_rate_limited');
    expect(structured['retry_after_seconds']).toBe(30);
    expect(JSON.stringify(result['content'])).toMatch(/retry_after_seconds/);
  });

  test('refuses an over-cap quote with a readable message', async () => {
    const relicId = await publishFixture();
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Feedback on text.',
      anchor: { kind: 'quote', exact: 'x'.repeat(513) },
    });

    expect(result['isError']).toBe(true);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('local_comment_anchor_quote_too_long');
    expect(structured['quote_bytes']).toBe(513);
    expect(structured['limit_bytes']).toBe(512);
    expect(JSON.stringify(result['content'])).toContain(
      'the exact quote is 513 bytes of UTF-8 and the limit is 512'
    );
    expect(posted).toHaveLength(0);
  });

  test('refuses over-cap context on a quote anchor', async () => {
    const relicId = await publishFixture();
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Feedback on text.',
      anchor: {
        kind: 'quote',
        exact: 'short phrase',
        prefix: 'p'.repeat(129),
      },
    });

    expect(result['isError']).toBe(true);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('local_comment_anchor_context_too_long');
    expect(structured['context_bytes']).toBe(129);
    expect(posted).toHaveLength(0);
  });

  test('refuses an out-of-range time with a readable message', async () => {
    const relicId = await publishFixture();
    const tooHigh = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Scene transition comment.',
      anchor: { kind: 'time', t: 90000 },
    });

    expect(tooHigh['isError']).toBe(true);
    const structured = tooHigh['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('local_comment_anchor_time_out_of_range');
    expect(structured['time_seconds']).toBe(90000);
    expect(structured['max_seconds']).toBe(86400);
    expect(JSON.stringify(tooHigh['content'])).toContain(
      'must be between 0 and 86400 seconds'
    );

    const negative = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Negative offset.',
      anchor: { kind: 'time', t: -5 },
    });
    expect(negative['isError']).toBe(true);
    expect(
      (negative['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_anchor_time_out_of_range');

    const invalid = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Malformed timecode.',
      anchor: { kind: 'time', t: '1:99' },
    });
    expect(invalid['isError']).toBe(true);
    expect(
      (invalid['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_anchor_time_invalid');
    expect(posted).toHaveLength(0);
  });

  test('refuses an inverted time span where end is before start', async () => {
    const relicId = await publishFixture();
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Inverted span.',
      anchor: { kind: 'time', t: 60, t_end: 45 },
    });

    expect(result['isError']).toBe(true);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('local_comment_anchor_time_span_invalid');
    expect(structured['t']).toBe(60);
    expect(structured['t_end']).toBe(45);
    expect(JSON.stringify(result['content'])).toContain(
      'must be strictly after the start time'
    );
    expect(posted).toHaveLength(0);
  });

  test('refuses an out-of-range page number', async () => {
    const relicId = await publishFixture();
    const zero = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Zero page.',
      anchor: { kind: 'page', page: 0 },
    });
    expect(zero['isError']).toBe(true);
    expect((zero['structuredContent'] as Record<string, unknown>)['code']).toBe(
      'local_comment_anchor_page_out_of_range'
    );

    const tooHigh = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Page past limit.',
      anchor: { kind: 'page', page: 10001 },
    });
    expect(tooHigh['isError']).toBe(true);
    expect(
      (tooHigh['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_anchor_page_out_of_range');
  });

  test('refuses an invalid or zero-area rectangle', async () => {
    const relicId = await publishFixture();
    const zeroArea = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Zero area box.',
      anchor: {
        kind: 'region',
        rect: { x: 0.1, y: 0.1, w: 0, h: 0.2 },
      },
    });
    expect(zeroArea['isError']).toBe(true);
    expect(
      (zeroArea['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_anchor_rect_zero_area');

    const overhang = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Overhanging box.',
      anchor: {
        kind: 'region',
        rect: { x: 0.8, y: 0.8, w: 0.5, h: 0.5 },
      },
    });
    expect(overhang['isError']).toBe(true);
    expect(
      (overhang['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_anchor_rect_overhang');
  });

  test('refuses unsupported anchor kind on write', async () => {
    const relicId = await publishFixture();
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Attempt to write unsupported.',
      anchor: { kind: 'unsupported', declared: 'future:3d' },
    });
    expect(result['isError']).toBe(true);
    expect(
      (result['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_anchor_unsupported');
  });
});

describe('reading comments back', () => {
  test('returns them oldest first, decrypted, with the author', async () => {
    const relicId = await publishFixture();
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'First pass looks right.',
    });
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Second thought: drop the appendix.',
      display_name: 'Reviewer',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });

    expect(result['isError']).toBe(false);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['count']).toBe(2);
    expect(structured['unreadable_count']).toBe(0);
    expect(structured['summary']).toEqual({
      total: 2,
      addressed: 0,
      open: 2,
      resolved: 0,
      unreadable: 0,
    });
    expect(structured['comments']).toEqual([
      {
        comment_id: 'c1',
        author: 'publisher',
        created_at: '2026-08-20T00:00:00Z',
        display_name: null,
        body: 'First pass looks right.',
        anchor: null,
        addresses: null,
        readable: true,
        unreadable_reason: null,
        addressed: false,
        addressed_by: null,
        addressed_by_comment_id: null,
        addressed_by_version: null,
        version: 1,
        edited_at: null,
        resolution: null,
      },
      {
        comment_id: 'c2',
        author: 'publisher',
        created_at: '2026-08-20T01:00:00Z',
        display_name: 'Reviewer',
        body: 'Second thought: drop the appendix.',
        anchor: null,
        addresses: null,
        readable: true,
        unreadable_reason: null,
        addressed: false,
        addressed_by: null,
        addressed_by_comment_id: null,
        addressed_by_version: null,
        version: 1,
        edited_at: null,
        resolution: null,
      },
    ]);
    const text = JSON.stringify(result['content']);
    expect(text).toMatch(/drop the appendix/);
    expect(text).toMatch(/oldest first/);
  });

  test('a mark reaches the agent, in the structure and in the transcript', async () => {
    // The defect this replaces: the anchor decrypted fine and was then
    // dropped, so an agent could not tell "this line is wrong" from a general
    // remark, and could not find the line either. Proven live against
    // production before it was fixed.
    const relicId = await publishFixture();
    const commentKey = await deriveCommentKey(
      decodeKey(await storedKey(relicId))
    );

    stored.push({
      comment_id: 'c1',
      author: 'reader@example.com',
      created_at: '2026-08-20T00:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'This sentence is the wrong one.',
        display_name: null,
        anchor: { kind: 'text', quote: 'the kestrel audits the lighthouse' },
      }),
    });
    stored.push({
      comment_id: 'c2',
      author: 'reader@example.com',
      created_at: '2026-08-20T01:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'And this bit of the diagram.',
        display_name: null,
        anchor: { kind: 'pin', x: 0.25, y: 0.8 },
      }),
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    const structured = result['structuredContent'] as Record<string, unknown>;
    const comments = structured['comments'] as Array<Record<string, unknown>>;

    expect(comments[0]?.['anchor']).toEqual({
      kind: 'text',
      quote: 'the kestrel audits the lighthouse',
    });
    expect(comments[1]?.['anchor']).toEqual({ kind: 'pin', x: 0.25, y: 0.8 });

    // And in the prose, because a field an agent has to go looking for is
    // most of the way back to not having it.
    const text = JSON.stringify(result['content']);
    expect(text).toContain('on \\"the kestrel audits the lighthouse\\"');
    expect(text).toContain('at 25% across, 80% down');
  });

  test('says so when there are none', async () => {
    const relicId = await publishFixture();
    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['count']).toBe(0);
    expect(structured['comments']).toEqual([]);
    expect(JSON.stringify(result['content'])).toMatch(/No comments/);
  });

  test('reports a comment that will not decrypt instead of skipping it', async () => {
    const relicId = await publishFixture();
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'This one opens.',
    });

    // A body encrypted under some other relic's key: the shape the service
    // would return if a comment were written against a different fragment.
    const foreignKey = await deriveCommentKey(generateKey());
    stored.push({
      comment_id: 'c-foreign',
      author: 'someone@example.invalid',
      created_at: '2026-08-20T02:00:00Z',
      ciphertext: await encryptComment(foreignKey, {
        body: 'unreadable here',
        display_name: null,
      }),
    });
    stored.push({
      comment_id: 'c-empty',
      author: 'someone@example.invalid',
      created_at: '2026-08-20T03:00:00Z',
      ciphertext: '',
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });

    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['count']).toBe(3);
    expect(structured['unreadable_count']).toBe(2);
    const comments = structured['comments'] as Record<string, unknown>[];
    expect(comments[0]?.['readable']).toBe(true);
    expect(comments[1]?.['readable']).toBe(false);
    expect(comments[1]?.['body']).toBeNull();
    expect(String(comments[1]?.['unreadable_reason'])).toMatch(
      /did not decrypt/
    );
    expect(comments[2]?.['readable']).toBe(false);
    // The whole call still succeeds: a partial read is not a failed read.
    expect(result['isError']).toBe(false);
    const text = JSON.stringify(result['content']);
    expect(text).toMatch(/partially unread/);
    expect(text).toMatch(/unreadable/);
  });

  test('refuses a comment list that is not an array', async () => {
    const relicId = await publishFixture();
    refuseComments = null;
    // The wrapper stands in only for the comment read; the base fetch is
    // captured before reassignment so the current-version mint this read
    // now does resolves against the real stub rather than wrapping itself.
    const base = deps.fetch;
    deps = {
      ...deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : String(input));
        if (url.pathname.endsWith('/comments') && init?.method !== 'POST') {
          return Response.json({ comments: [] });
        }
        return base(input, init);
      }) as typeof globalThis.fetch,
    };

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(result['isError']).toBe(true);
    expect(
      (result['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('app_response_unusable');
  });

  test('renders descriptions with the exact facts an agent needs for every anchor kind', async () => {
    const relicId = await publishFixture();
    const commentKey = await deriveCommentKey(
      decodeKey(await storedKey(relicId))
    );

    stored.push({
      comment_id: 'c1',
      author: 'alice@example.com',
      created_at: '2026-08-20T00:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'Consider clarifying this phrase.',
        display_name: 'Alice',
        anchor: {
          kind: 'quote',
          exact: 'the kestrel audits the lighthouse',
          prefix: 'as evening fell, ',
          suffix: ' with quiet precision',
        },
      }),
    });

    stored.push({
      comment_id: 'c2',
      author: 'bob@example.com',
      created_at: '2026-08-20T01:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'Check the artifact contrast here.',
        display_name: 'Bob',
        anchor: {
          kind: 'region',
          rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
        },
      }),
    });

    stored.push({
      comment_id: 'c3',
      author: 'carol@example.com',
      created_at: '2026-08-20T02:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'Audio clip distortion.',
        display_name: 'Carol',
        anchor: {
          kind: 'time',
          t: 83,
          t_end: 105,
          rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
        },
      }),
    });

    stored.push({
      comment_id: 'c4',
      author: 'dave@example.com',
      created_at: '2026-08-20T03:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'Typo on this page.',
        display_name: 'Dave',
        anchor: {
          kind: 'page',
          page: 5,
          exact: 'the final appendix figure',
        },
      }),
    });

    stored.push({
      comment_id: 'c5',
      author: 'eve@example.com',
      created_at: '2026-08-20T04:00:00Z',
      ciphertext: await encryptComment(commentKey, {
        body: 'Overall impression is strong.',
        display_name: 'Eve',
        anchor: null,
      }),
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(result['isError']).toBe(false);

    const structured = result['structuredContent'] as Record<string, unknown>;
    const comments = structured['comments'] as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(5);

    expect(comments[0]?.['anchor']).toEqual({
      kind: 'quote',
      exact: 'the kestrel audits the lighthouse',
      prefix: 'as evening fell, ',
      suffix: ' with quiet precision',
    });

    expect(comments[1]?.['anchor']).toEqual({
      kind: 'region',
      rect: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    });

    expect(comments[2]?.['anchor']).toEqual({
      kind: 'time',
      t: 83,
      t_end: 105,
      rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    });

    expect(comments[3]?.['anchor']).toEqual({
      kind: 'page',
      page: 5,
      exact: 'the final appendix figure',
    });

    expect(comments[4]?.['anchor']).toBeNull();

    const text = JSON.stringify(result['content']);

    expect(text).toContain('on \\"the kestrel audits the lighthouse\\"');
    expect(text).toContain(
      'context: \\"as evening fell, \\" before, \\" with quiet precision\\" after'
    );
    expect(text).toContain(
      'in region (upper left, 10% across, 10% down, 20% wide by 20% high)'
    );
    expect(text).toContain(
      'at 1:23 to 1:45 in region (centre, 40% across, 40% down, 20% wide by 20% high)'
    );
    expect(text).toContain('on page 5 at \\"the final appendix figure\\"');
    expect(text).toContain('about the whole relic');
  });

  test('reports comments with unsupported anchors as readable with body intact', async () => {
    const relicId = await publishFixture();
    const commentKey = await deriveCommentKey(
      decodeKey(await storedKey(relicId))
    );

    // Simulates an anchor from a newer format version written by another client
    const ciphertext = await sealRawComment(
      commentKey,
      JSON.stringify({
        body: 'Notes attached to a 3D bounding mesh.',
        display_name: 'Future Client',
        anchor: {
          kind: 'model3d:mesh',
          mesh_id: 'xyz-123',
        },
      })
    );

    stored.push({
      comment_id: 'c-future',
      author: 'future@example.com',
      created_at: '2026-08-20T05:00:00Z',
      ciphertext,
    });

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(result['isError']).toBe(false);

    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['unreadable_count']).toBe(0);
    const comments = structured['comments'] as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(1);

    const comment = comments[0];
    expect(comment?.['readable']).toBe(true);
    expect(comment?.['unreadable_reason']).toBeNull();
    expect(comment?.['body']).toBe('Notes attached to a 3D bounding mesh.');
    expect(comment?.['anchor']).toEqual({
      kind: 'unsupported',
      declared: 'model3d:mesh',
    });

    const text = JSON.stringify(result['content']);
    expect(text).toContain(
      'carrying a mark this client does not understand (declared kind \\"model3d:mesh\\")'
    );
    expect(text).toContain('Notes attached to a 3D bounding mesh.');
    expect(text).not.toContain('[unreadable:');
  });
});

describe('the machine boundary', () => {
  const elsewhere = '01jw0000000000000000000000';

  test('refuses to read comments on a relic published elsewhere', async () => {
    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: elsewhere,
    });
    expect(result['isError']).toBe(true);
    const structured = result['structuredContent'] as Record<string, unknown>;
    expect(structured['code']).toBe('no_local_publish_state');
    const text = JSON.stringify(result['content']);
    expect(text).toMatch(/published from another machine/);
    expect(text).toMatch(/neither read nor written here/);
  });

  test('refuses to write a comment on a relic published elsewhere', async () => {
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: elsewhere,
      body: 'Cannot attribute this.',
    });
    expect(result['isError']).toBe(true);
    expect(
      (result['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('no_local_publish_state');
    expect(posted).toHaveLength(0);
  });

  test('refuses a share URL and says to pass the id instead', async () => {
    const relicId = await publishFixture();
    const key = await storedKey(relicId);

    const result = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: `${SERVICE}/${relicId}#r1${key}`,
    });

    expect(result['isError']).toBe(true);
    expect(
      (result['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('no_local_publish_state');
    expect(JSON.stringify(result['content'])).toMatch(
      /never the share URL: the URL carries the key in its fragment/
    );
  });
});

describe('what an agent is told before it calls anything', () => {
  test('both tools are listed with their machine boundary', async () => {
    const response = await handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      deps
    );
    // The server's own definitions, read back through the protocol.
    const listed = response?.result as {
      tools: { name: string; description: string }[];
    };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toContain(READ_COMMENTS_TOOL_NAME);
    expect(names).toContain(COMMENT_TOOL_NAME);

    for (const name of [READ_COMMENTS_TOOL_NAME, COMMENT_TOOL_NAME]) {
      const tool = listed.tools.find((candidate) => candidate.name === name);
      expect(tool).toBeDefined();
      expect(tool?.description).toMatch(/Only works for a relic this machine/);
      expect(tool?.description).toMatch(/never the share URL/);
    }
  });
});

describe('anchor round-trip through write and read tools', () => {
  test('writes each anchor kind and reads it back naming the same place', async () => {
    const relicId = await publishFixture();

    // 1. Text anchor
    const textRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on text.',
      anchor: { kind: 'text', quote: 'original passage' },
    });
    expect(textRes['isError']).toBe(false);

    // 2. Quote anchor with disambiguating context
    const quoteRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on quote.',
      anchor: {
        kind: 'quote',
        exact: 'target run',
        prefix: 'intro ',
        suffix: ' outro',
      },
    });
    expect(quoteRes['isError']).toBe(false);

    // 3. Pin anchor
    const pinRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on pin.',
      anchor: { kind: 'pin', x: 0.3, y: 0.7 },
    });
    expect(pinRes['isError']).toBe(false);

    // 4. Region anchor
    const regionRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on region.',
      anchor: {
        kind: 'region',
        rect: { x: 0.05, y: 0.05, w: 0.25, h: 0.25 },
      },
    });
    expect(regionRes['isError']).toBe(false);

    // 5. Time anchor with timecode string that must round-trip to the same offset
    const timeRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on timecode.',
      anchor: {
        kind: 'time',
        t: '1:23',
        t_end: '1:45',
      },
    });
    expect(timeRes['isError']).toBe(false);

    // 6. Time anchor with seconds number and box
    const timeBoxRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on media box.',
      anchor: {
        kind: 'time',
        t: 3723,
        rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
      },
    });
    expect(timeBoxRes['isError']).toBe(false);

    // 7. Page anchor with exact quote
    const pageQuoteRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on page quote.',
      anchor: {
        kind: 'page',
        page: 4,
        exact: 'table caption',
      },
    });
    expect(pageQuoteRes['isError']).toBe(false);

    // 8. Page anchor with rect
    const pageBoxRes = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Comment on page box.',
      anchor: {
        kind: 'page',
        page: 9,
        rect: { x: 0.1, y: 0.7, w: 0.3, h: 0.2 },
      },
    });
    expect(pageBoxRes['isError']).toBe(false);

    // Read all comments back through relic_read_comments
    const readResult = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(readResult['isError']).toBe(false);

    const structured = readResult['structuredContent'] as Record<
      string,
      unknown
    >;
    expect(structured['count']).toBe(8);
    const comments = structured['comments'] as Array<Record<string, unknown>>;
    expect(posted).toHaveLength(8);
    for (const request of posted) {
      expect(Object.hasOwn(request, 'version')).toBe(false);
    }
    expect(comments[0]?.['anchor']).toEqual({
      kind: 'text',
      quote: 'original passage',
    });
    expect(comments[1]?.['anchor']).toEqual({
      kind: 'quote',
      exact: 'target run',
      prefix: 'intro ',
      suffix: ' outro',
    });
    expect(comments[2]?.['anchor']).toEqual({ kind: 'pin', x: 0.3, y: 0.7 });
    expect(comments[3]?.['anchor']).toEqual({
      kind: 'region',
      rect: { x: 0.05, y: 0.05, w: 0.25, h: 0.25 },
    });
    expect(comments[4]?.['anchor']).toEqual({
      kind: 'time',
      t: 83,
      t_end: 105,
    });
    expect(comments[5]?.['anchor']).toEqual({
      kind: 'time',
      t: 3723,
      rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
    });
    expect(comments[6]?.['anchor']).toEqual({
      kind: 'page',
      page: 4,
      exact: 'table caption',
    });
    expect(comments[7]?.['anchor']).toEqual({
      kind: 'page',
      page: 9,
      rect: { x: 0.1, y: 0.7, w: 0.3, h: 0.2 },
    });

    const text = JSON.stringify(readResult['content']);
    expect(text).toContain('on \\"original passage\\"');
    expect(text).toContain(
      'on \\"target run\\" (context: \\"intro \\" before, \\" outro\\" after)'
    );
    expect(text).toContain('at 30% across, 70% down (stage-relative point)');
    expect(text).toContain(
      'in region (upper left, 5% across, 5% down, 25% wide by 25% high)'
    );
    expect(text).toContain('at 1:23 to 1:45');
    expect(text).toContain(
      'at 1:02:03 in region (centre, 40% across, 40% down, 20% wide by 20% high)'
    );
    expect(text).toContain('on page 4 at \\"table caption\\"');
    expect(text).toContain(
      'on page 9 in region (lower left, 10% across, 70% down, 30% wide by 20% high)'
    );
  });
});

describe('timecode parsing and formatting helpers', () => {
  test('formats and parses timecodes symmetrically', () => {
    expect(formatTimecode(0)).toBe('0:00');
    expect(formatTimecode(83)).toBe('1:23');
    expect(formatTimecode(105)).toBe('1:45');
    expect(formatTimecode(3723)).toBe('1:02:03');

    expect(parseTimecode('1:23', 'test')).toBe(83);
    expect(parseTimecode('01:23', 'test')).toBe(83);
    expect(parseTimecode('1:02:03', 'test')).toBe(3723);
    expect(parseTimecode(83, 'test')).toBe(83);
    expect(parseTimecode(0, 'test')).toBe(0);
  });

  test('computes plain-language box positions', () => {
    expect(boxPosition({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 })).toBe('upper left');
    expect(boxPosition({ x: 0.4, y: 0.1, w: 0.2, h: 0.2 })).toBe(
      'upper centre'
    );
    expect(boxPosition({ x: 0.7, y: 0.1, w: 0.2, h: 0.2 })).toBe('upper right');
    expect(boxPosition({ x: 0.1, y: 0.4, w: 0.2, h: 0.2 })).toBe('middle left');
    expect(boxPosition({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe('centre');
    expect(boxPosition({ x: 0.7, y: 0.4, w: 0.2, h: 0.2 })).toBe(
      'middle right'
    );
    expect(boxPosition({ x: 0.1, y: 0.7, w: 0.2, h: 0.2 })).toBe('lower left');
    expect(boxPosition({ x: 0.4, y: 0.7, w: 0.2, h: 0.2 })).toBe(
      'lower centre'
    );
    expect(boxPosition({ x: 0.7, y: 0.7, w: 0.2, h: 0.2 })).toBe('lower right');
    expect(boxPosition({ x: 0.05, y: 0.05, w: 0.9, h: 0.9 })).toBe('centre');
  });

  test('describes anchors in words an agent can act on', () => {
    expect(describeAnchor(null)).toBe('about the whole relic');
    expect(describeAnchor({ kind: 'text', quote: 'sample quote' })).toBe(
      'on "sample quote"'
    );
    expect(
      describeAnchor({
        kind: 'quote',
        exact: 'sample exact',
        prefix: 'pre ',
      })
    ).toBe('on "sample exact" (context: "pre " before)');
    expect(
      describeAnchor({
        kind: 'unsupported',
        declared: 'custom:mark',
      })
    ).toBe(
      'carrying a mark this client does not understand (declared kind "custom:mark")'
    );
  });
});

afterEach(async () => {
  delete process.env['RELIC_PUBLISH_STATE'];
  delete process.env['RELIC_FFMPEG_PATH'];
  resetFfmpegCacheForTest();
  await rm(scratch, { recursive: true, force: true });
});

describe('comment anchor resolution against decrypted relic content', () => {
  /**
   * A real PNG, read off disk, needing no external tool.
   *
   * For the cases that only need bytes which classify as an image. The
   * synthesised fixtures below exist to put a known colour at a known
   * coordinate, which is worth a subprocess; merely being a PNG is not.
   */
  async function realPngFixture(): Promise<Uint8Array> {
    const path = new URL(
      '../../relic-viewer/public/card.v1.png',
      import.meta.url
    ).pathname;
    return new Uint8Array(await readFile(path));
  }

  async function makeSyntheticPng(
    width: number,
    height: number,
    box?: { x: number; y: number; w: number; h: number; color: string }
  ): Promise<Uint8Array> {
    const ffmpegPath = await probeFfmpeg(deps);
    if (!ffmpegPath)
      throw new Error('ffmpeg is required to build synthetic image fixtures');
    const filter = box
      ? `drawbox=x=${box.x}:y=${box.y}:w=${box.w}:h=${box.h}:color=${box.color}:t=fill`
      : 'null';
    return await runFfmpeg(
      ffmpegPath,
      [
        '-f',
        'lavfi',
        '-i',
        `color=c=black:s=${width}x${height}`,
        '-vf',
        filter,
        '-frames:v',
        '1',
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1',
      ],
      new Uint8Array(0)
    );
  }

  async function makeSyntheticMp4(durationSeconds = 2): Promise<Uint8Array> {
    const ffmpegPath = await probeFfmpeg(deps);
    if (!ffmpegPath)
      throw new Error('ffmpeg is required to build synthetic video fixtures');
    return await runFfmpeg(
      ffmpegPath,
      [
        '-f',
        'lavfi',
        '-i',
        `testsrc=duration=${durationSeconds}:size=160x120:rate=1`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        'frag_keyframe+empty_moov',
        '-f',
        'mp4',
        'pipe:1',
      ],
      new Uint8Array(0)
    );
  }

  test('synthetic image region crop extracts the exact colored square pixels', async () => {
    const ffmpegPath = await probeFfmpeg(deps);
    expect(ffmpegPath).toBeDefined();
    if (!ffmpegPath) throw new Error('ffmpeg is required for this test');

    // 100x100 black image with a pure red filled square at x=60, y=10, w=30, h=30
    const pngBytes = await makeSyntheticPng(100, 100, {
      x: 60,
      y: 10,
      w: 30,
      h: 30,
      color: 'red',
    });
    const imagePath = join(scratch, 'target-test.png');
    await writeFile(imagePath, pngBytes);
    const published = await publish(
      { path: imagePath, filename: 'target-test.png' },
      deps
    );

    // Region covers the red box exactly: x=0.6, y=0.1, w=0.3, h=0.3
    const postResult = await callTool(COMMENT_TOOL_NAME, {
      relic_id: published.relic_id,
      body: 'this box should be red',
      anchor: {
        kind: 'region',
        rect: { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
      },
    });
    expect(postResult['isError']).toBe(false);

    const readResult = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: published.relic_id,
      resolve_anchors: true,
    });
    expect(readResult['isError']).toBe(false);

    const content = readResult['content'] as Array<{
      type: string;
      text?: string;
      data?: string;
      mimeType?: string;
    }>;
    const imageBlocks = content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(2);

    // First image block is the crop: decode it to raw rgb24 pixels
    const cropBlock = imageBlocks[0];
    expect(cropBlock?.data).toBeDefined();
    const cropBytes = new Uint8Array(
      Buffer.from(cropBlock?.data ?? '', 'base64')
    );
    const rawRgb = await runFfmpeg(
      ffmpegPath,
      ['-i', 'pipe:0', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
      cropBytes
    );

    expect(rawRgb.length).toBeGreaterThan(0);
    let redCount = 0;
    for (let i = 0; i < rawRgb.length; i += 3) {
      const r = rawRgb[i] ?? 0;
      const g = rawRgb[i + 1] ?? 0;
      const b = rawRgb[i + 2] ?? 0;
      if (r > 200 && g < 30 && b < 30) {
        redCount++;
      }
    }
    const totalPixels = rawRgb.length / 3;
    expect(redCount).toBe(totalPixels);

    const structured = readResult['structuredContent'] as Record<
      string,
      unknown
    >;
    const comments = structured['comments'] as Array<Record<string, unknown>>;
    expect(comments[0]?.['resolved']).toEqual({
      kind: 'region',
      status: 'resolved',
      original_width: 100,
      original_height: 100,
      downscaled: false,
      crop_box_pixels: {
        x: 60,
        y: 10,
        w: 30,
        h: 30,
      },
    });
  });

  test('returns the right blocks per anchor kind', async () => {
    const ffmpegPath = await probeFfmpeg(deps);
    expect(ffmpegPath).toBeDefined();

    // 1. Region on image: returns two image blocks (crop and annotated context)
    const imageBytes = await makeSyntheticPng(200, 200);
    const imgPath = join(scratch, 'sample.png');
    await writeFile(imgPath, imageBytes);
    const imgRelic = await publish(
      { path: imgPath, filename: 'sample.png' },
      deps
    );

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: imgRelic.relic_id,
      body: 'look at the corner',
      anchor: { kind: 'region', rect: { x: 0.1, y: 0.1, w: 0.4, h: 0.4 } },
    });

    const imgRead = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: imgRelic.relic_id,
      resolve_anchors: true,
    });
    const imgContent = imgRead['content'] as Array<{
      type: string;
      text?: string;
      data?: string;
    }>;
    const imgImages = imgContent.filter((b) => b.type === 'image');
    expect(imgImages).toHaveLength(2);

    // 2. Time span on video: returns two frames (start frame and end frame)
    const videoBytes = await makeSyntheticMp4(3);
    const videoPath = join(scratch, 'sample.mp4');
    await writeFile(videoPath, videoBytes);
    const videoRelic = await publish(
      { path: videoPath, filename: 'sample.mp4' },
      deps
    );

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: videoRelic.relic_id,
      body: 'this span is jarring',
      anchor: { kind: 'time', t: 0, t_end: 1 },
    });

    const videoRead = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: videoRelic.relic_id,
      resolve_anchors: true,
    });
    const videoContent = videoRead['content'] as Array<{
      type: string;
      text?: string;
      data?: string;
    }>;
    const videoImages = videoContent.filter((b) => b.type === 'image');
    expect(videoImages).toHaveLength(2);

    // 3. Pin on any relic: returns text only with the honest stage-relative explanation
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: imgRelic.relic_id,
      body: 'general pin mark',
      anchor: { kind: 'pin', x: 0.25, y: 0.75 },
    });

    const pinRead = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: imgRelic.relic_id,
      resolve_anchors: true,
    });
    const pinStructured = pinRead['structuredContent'] as Record<
      string,
      unknown
    >;
    const pinComments = pinStructured['comments'] as Array<
      Record<string, unknown>
    >;
    const pinComment = pinComments.find(
      (c) => (c['anchor'] as { kind?: string })?.kind === 'pin'
    );
    expect(pinComment?.['resolved']).toMatchObject({
      kind: 'pin',
      status: 'unresolvable',
      x: 0.25,
      y: 0.75,
    });
    const pinText =
      (pinRead['content'] as Array<{ type: string; text?: string }>)[0]?.text ??
      '';
    expect(pinText).toContain('Pins are placed relative to the viewer stage');

    // 4. Quote on text document: returns text only with quotation and line context
    const docText =
      '# System Overview\n\nAll components must have exact tolerances.\n\nEnd of spec.\n';
    const docPath = join(scratch, 'spec.md');
    await writeFile(docPath, docText);
    const docRelic = await publish(
      { path: docPath, filename: 'spec.md' },
      deps
    );

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: docRelic.relic_id,
      body: 'tighten this rule',
      anchor: {
        kind: 'quote',
        exact: 'exact tolerances',
        prefix: 'must have ',
        suffix: '.\n\nEnd',
      },
    });

    const docRead = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: docRelic.relic_id,
      resolve_anchors: true,
    });
    const docContent = docRead['content'] as Array<{
      type: string;
      text?: string;
    }>;
    const docImages = docContent.filter((b) => b.type === 'image');
    expect(docImages).toHaveLength(0);
    const docTranscript = docContent[0]?.text ?? '';
    expect(docTranscript).toContain('Quotation:\n>>> exact tolerances <<<');
    expect(docTranscript).toContain('Source context (line 3):');

    // 5. Time on audio: returns text only noting that audio has no visual frames
    const audioPath = join(scratch, 'narration.mp3');
    await writeFile(
      audioPath,
      new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0x00, 0x00])
    );
    const audioRelic = await publish(
      { path: audioPath, filename: 'narration.mp3' },
      deps
    );

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: audioRelic.relic_id,
      body: 'audio pop here',
      anchor: { kind: 'time', t: 45 },
    });

    const audioRead = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: audioRelic.relic_id,
      resolve_anchors: true,
    });
    const audioContent = audioRead['content'] as Array<{
      type: string;
      text?: string;
    }>;
    const audioImages = audioContent.filter((b) => b.type === 'image');
    expect(audioImages).toHaveLength(0);
    const audioTranscript = audioContent[0]?.text ?? '';
    expect(audioTranscript).toContain(
      'Audio relics have no visual frames to display'
    );

    // 6. Page on PDF: returns page number and quote with honest notice about server-side PDF rendering
    const pdfPath = join(scratch, 'brief.pdf');
    await writeFile(pdfPath, '%PDF-1.4\n%trailer\n');
    const pdfRelic = await publish(
      { path: pdfPath, filename: 'brief.pdf' },
      deps
    );

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: pdfRelic.relic_id,
      body: 'check header on page 4',
      anchor: { kind: 'page', page: 4, exact: 'Revenue Summary' },
    });

    const pdfRead = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: pdfRelic.relic_id,
      resolve_anchors: true,
    });
    const pdfContent = pdfRead['content'] as Array<{
      type: string;
      text?: string;
    }>;
    const pdfImages = pdfContent.filter((b) => b.type === 'image');
    expect(pdfImages).toHaveLength(0);
    const pdfTranscript = pdfContent[0]?.text ?? '';
    expect(pdfTranscript).toContain(
      'server-side PDF page rendering is omitted'
    );
    expect(pdfTranscript).toContain(
      'Quotation on page 4:\n>>> Revenue Summary <<<'
    );
  });

  test('unresolvable anchor returns description with honest explanation and no image block', async () => {
    const docPath = join(scratch, 'v1.md');
    await writeFile(docPath, '# Heading\n\nShort initial text.\n');
    const relic = await publish({ path: docPath, filename: 'v1.md' }, deps);

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relic.relic_id,
      body: 'this paragraph is missing',
      anchor: {
        kind: 'text',
        quote: 'paragraph that does not exist in the file',
      },
    });

    const readResult = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relic.relic_id,
      resolve_anchors: true,
    });
    expect(readResult['isError']).toBe(false);

    const content = readResult['content'] as Array<{
      type: string;
      text?: string;
    }>;
    const imageBlocks = content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(0);

    const transcript = content[0]?.text ?? '';
    expect(transcript).toContain(
      'on "paragraph that does not exist in the file"'
    );
    expect(transcript).toContain(
      'The quoted text was not found in the current relic content'
    );
  });

  test('ffmpeg being absent degrades to text and does not throw', async () => {
    // A real PNG off disk rather than a synthesised one, because this test is
    // about ffmpeg being unavailable and building its fixture with ffmpeg
    // made it require the very thing whose absence it asserts. It passed only
    // on a machine that had ffmpeg, which is the one machine where the
    // behaviour under test never happens.
    const pngBytes = await realPngFixture();
    const imagePath = join(scratch, 'fallback.png');
    await writeFile(imagePath, pngBytes);
    const relic = await publish(
      { path: imagePath, filename: 'fallback.png' },
      deps
    );

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relic.relic_id,
      body: 'inspect this edge',
      anchor: { kind: 'region', rect: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } },
    });

    // Simulate ffmpeg being unavailable
    const depsWithoutFfmpeg: PublishDeps = {
      ...deps,
      ffmpegPath: null,
    };

    const response = await handleMessage(
      {
        jsonrpc: '2.0',
        id: 99,
        method: 'tools/call',
        params: {
          name: READ_COMMENTS_TOOL_NAME,
          arguments: { relic_id: relic.relic_id, resolve_anchors: true },
        },
      },
      depsWithoutFfmpeg
    );

    expect(response?.result).toBeDefined();
    const result = response?.result as Record<string, unknown>;
    expect(result['isError']).toBe(false);

    const content = result['content'] as Array<{ type: string; text?: string }>;
    const imageBlocks = content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(0);

    const transcript = content[0]?.text ?? '';
    expect(transcript).toContain('ffmpeg is not available on this machine');
  });

  test('N comments on one relic cause exactly one fetch', async () => {
    const docPath = join(scratch, 'shared.md');
    await writeFile(
      docPath,
      '# Shared doc\n\nFirst line.\nSecond line.\nThird line.\n'
    );
    const relic = await publish({ path: docPath, filename: 'shared.md' }, deps);

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relic.relic_id,
      body: 'comment one',
      anchor: { kind: 'text', quote: 'First line.' },
    });
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relic.relic_id,
      body: 'comment two',
      anchor: { kind: 'text', quote: 'Second line.' },
    });
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relic.relic_id,
      body: 'comment three',
      anchor: { kind: 'text', quote: 'Third line.' },
    });

    expect(mintFetchCount).toBe(0);
    expect(containerDownloadCount).toBe(0);

    const readResult = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relic.relic_id,
      resolve_anchors: true,
    });
    expect(readResult['isError']).toBe(false);

    // Exactly one content mint and one container download occurred for all
    // three comments; the second mint was the default scope resolving the
    // current version from the service, which is a separate, cheaper read.
    expect(mintFetchCount).toBe(2);
    expect(containerDownloadCount).toBe(1);

    const structured = readResult['structuredContent'] as Record<
      string,
      unknown
    >;
    const comments = structured['comments'] as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(3);
    expect(comments[0]?.['resolved']).toMatchObject({
      status: 'resolved',
      exact: 'First line.',
    });
    expect(comments[1]?.['resolved']).toMatchObject({
      status: 'resolved',
      exact: 'Second line.',
    });
    expect(comments[2]?.['resolved']).toMatchObject({
      status: 'resolved',
      exact: 'Third line.',
    });
  });

  test('cost gate: with resolution off, no fetch happens', async () => {
    const docPath = join(scratch, 'gated.md');
    await writeFile(docPath, '# Gated\n\nContent here.\n');
    const relic = await publish({ path: docPath, filename: 'gated.md' }, deps);

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relic.relic_id,
      body: 'comment on gated content',
      anchor: { kind: 'text', quote: 'Content here.' },
    });

    // Read without resolve_anchors (default: false)
    const readDefault = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relic.relic_id,
    });
    expect(readDefault['isError']).toBe(false);
    // No content fetch: the only mint was the default scope resolving the
    // current version from the service, and resolving anchors never touched
    // the container.
    expect(mintFetchCount).toBe(1);
    expect(containerDownloadCount).toBe(0);

    // Read with explicit resolve_anchors: false
    const readExplicitFalse = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relic.relic_id,
      resolve_anchors: false,
    });
    expect(readExplicitFalse['isError']).toBe(false);
    expect(mintFetchCount).toBe(2);
    expect(containerDownloadCount).toBe(0);

    const structured = readDefault['structuredContent'] as Record<
      string,
      unknown
    >;
    const comments = structured['comments'] as Array<Record<string, unknown>>;
    expect(comments[0]?.['resolved']).toBeUndefined();
  });

  test('downscales large image regions exceeding byte cap and reports notice in text', async () => {
    const ffmpegPath = await probeFfmpeg(deps);
    expect(ffmpegPath).toBeDefined();

    // Create 1600x1200 image (width exceeds MAX_IMAGE_DIMENSION of 1200)
    const largePng = await makeSyntheticPng(1600, 1200, {
      x: 100,
      y: 100,
      w: 400,
      h: 300,
      color: 'blue',
    });
    const largePath = join(scratch, 'large.png');
    await writeFile(largePath, largePng);
    const relic = await publish(
      { path: largePath, filename: 'large.png' },
      deps
    );

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relic.relic_id,
      body: 'large image inspection',
      anchor: { kind: 'region', rect: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
    });

    const readResult = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relic.relic_id,
      resolve_anchors: true,
    });
    expect(readResult['isError']).toBe(false);

    const structured = readResult['structuredContent'] as Record<
      string,
      unknown
    >;
    const comments = structured['comments'] as Array<Record<string, unknown>>;
    const resolved = comments[0]?.['resolved'] as Record<string, unknown>;
    expect(resolved['downscaled']).toBe(true);
    expect(resolved['original_width']).toBe(1600);
    expect(resolved['original_height']).toBe(1200);

    const content = readResult['content'] as Array<{
      type: string;
      text?: string;
      data?: string;
    }>;
    const transcript = content[0]?.text ?? '';
    expect(transcript).toContain('Downscaled from 1600x1200');
  });

  test('dead or expired relic returns unresolvable notice without throwing', async () => {
    const relicId = await publishFixture();
    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'comment on dying relic',
      anchor: { kind: 'text', quote: 'under review' },
    });

    // Simulate 410 Gone on mint. The read is scoped explicitly, so the
    // current-version read does not mint at all, and the refusal lands on
    // anchor resolution, which is the leg this test is about.
    refuseMint = { status: 410, body: { code: 'relic_expired' } };

    const readResult = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
      version: 1,
      resolve_anchors: true,
    });
    expect(readResult['isError']).toBe(false);

    const content = readResult['content'] as Array<{
      type: string;
      text?: string;
    }>;
    const imageBlocks = content.filter((b) => b.type === 'image');
    expect(imageBlocks).toHaveLength(0);

    const transcript = content[0]?.text ?? '';
    expect(transcript).toContain('expired');
  });
});
describe('reply pointers and comment state', () => {
  test('sends sealed addresses pointer and clear routing hint to service', async () => {
    const relicId = await publishFixture();
    const result = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Addressed in update.',
      addresses: 'c1',
    });

    expect(result['isError']).toBe(false);
    expect(posted).toHaveLength(1);
    const request = posted[0];
    expect(request?.['addresses']).toBe('c1');

    const commentKey = await deriveCommentKey(
      decodeKey(await storedKey(relicId))
    );
    const decrypted = await decryptComment(
      commentKey,
      String(request?.['ciphertext'])
    );
    expect(decrypted.addresses).toBe('c1');
    expect(decrypted.body).toBe('Addressed in update.');
  });

  test('refuses empty addresses or over-cap addresses', async () => {
    const relicId = await publishFixture();

    const empty = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'A reply.',
      addresses: '   ',
    });
    expect(empty['isError']).toBe(true);
    expect(
      (empty['structuredContent'] as Record<string, unknown>)['code']
    ).toBe('local_comment_addresses_invalid');

    const long = await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'A reply.',
      addresses: 'x'.repeat(65),
    });
    expect(long['isError']).toBe(true);
    expect((long['structuredContent'] as Record<string, unknown>)['code']).toBe(
      'local_comment_addresses_too_long'
    );
  });

  test('surfaces addressed status, addressed_by, and compact summary', async () => {
    const relicId = await publishFixture();

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Please fix this heading.',
    });

    await callTool(COMMENT_TOOL_NAME, {
      relic_id: relicId,
      body: 'Heading has been revised.',
      addresses: 'c1',
    });

    const read = await callTool(READ_COMMENTS_TOOL_NAME, {
      relic_id: relicId,
    });
    expect(read['isError']).toBe(false);
    const structured = read['structuredContent'] as Record<string, unknown>;
    expect(structured['summary']).toEqual({
      total: 2,
      addressed: 1,
      open: 0,
      resolved: 0,
      unreadable: 0,
    });

    const comments = structured['comments'] as Array<Record<string, unknown>>;
    expect(comments).toHaveLength(2);
    expect(comments[0]?.['comment_id']).toBe('c1');
    expect(comments[0]?.['addressed']).toBe(true);
    expect(comments[0]?.['addressed_by']).toEqual({
      comment_id: 'c2',
      version: 1,
    });

    expect(comments[1]?.['comment_id']).toBe('c2');
    expect(comments[1]?.['addresses']).toBe('c1');
    expect(comments[1]?.['addressed']).toBe(false);
    expect(comments[1]?.['addressed_by']).toBeNull();

    const transcript = JSON.stringify(read['content']);
    expect(transcript).toContain('[answers comment c1]');
    expect(transcript).toContain('[addressed by comment c2 in v1]');
    expect(transcript).toContain(
      'Summary: 2 total, 1 addressed, 0 open, 0 resolved, 0 unreadable.'
    );
  });
});
