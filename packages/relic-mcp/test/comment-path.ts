/**
 * The agent's comment round trip, as a repeatable command.
 *
 *   bun test/comment-path.ts
 *
 * A sibling of `source-versioning-path.ts` rather than an extension of it,
 * because it asserts a different thing: that half of the comment feature works
 * for the party that cannot receive email. It publishes, comments, reads the
 * comment back from a *fresh process* holding nothing but the state file,
 * shows the stored row is ciphertext, and proves a relic this machine did not
 * publish is refused.
 *
 * The service is a real HTTP listener on loopback rather than a fetch stub, so
 * the fresh process talks to it exactly as it would talk to Relic, and the
 * body it stores can be inspected the way an operator would see it.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { COMMENT_TOOL_NAME, READ_COMMENTS_TOOL_NAME } from '../src/server.ts';
import { loadPublishState, publishStatePath } from '../src/state.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const viewerDist = fileURLToPath(
  new URL('../../relic-viewer/dist/', import.meta.url)
);
const scratch = await mkdtemp(join(tmpdir(), 'relic-comment-path-'));
process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'test-operator-secret']]);

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});

function origin(): string {
  return `http://127.0.0.1:${service.port}`;
}

const storage = new MemoryStorage(`${origin()}/__storage`);

const app = createApp({
  config: {
    serviceOrigin: origin(),
  },
  store,
  storage,
  now: () => Date.now(),
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async () => {},
    sendMail: async () => {},
  },
});

let acceptedToken: string | undefined;

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    const bytes = new Uint8Array(await request.arrayBuffer());
    storage.put(relicId, bytes);
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const relicId = url.pathname.slice('/__storage/o/'.length);
    const bytes = await storage.read(relicId);
    if (!bytes) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  if (url.pathname.endsWith('/comments') && request.method === 'POST') {
    const clone = request.clone();
    const body = (await clone.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    acceptedToken =
      typeof body['publish_token'] === 'string'
        ? body['publish_token']
        : undefined;
  }
  return app.fetch(request);
};

/** A fresh process, holding nothing but the state file on disk. */
async function callFresh(
  name: string,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['bun', join(packageRoot, 'src', 'index.ts')], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RELIC_CHROME_PATH: 'none',
      RELIC_SERVICE_ORIGIN: origin(),
      RELIC_PUBLISH_STATE: publishStatePath(),
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    })}\n`
  );
  child.stdin.end();
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 0, stderr);
  assert.equal(stderr, '');
  const response = JSON.parse(stdout.trim()) as Record<string, unknown>;
  return response['result'] as Record<string, unknown>;
}

try {
  const deps: PublishDeps = {
    serviceOrigin: origin(),
    relicOrigin: origin(),
    files: nodeFiles,
    fetch: globalThis.fetch,
    clientName: 'relic-mcp/comment-path',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'comment-path test runner',
    }),
  };

  const path = join(scratch, 'report.md');
  await writeFile(path, '# quarterly report\n\nDraft for review.\n');
  const published = await publish({ path }, deps);
  const relicId = published.relic_id;
  console.log(`PUBLISHED relic_id=${relicId}`);

  const body = 'The second chart still uses last quarter numbers.';
  const written = await callFresh(COMMENT_TOOL_NAME, {
    relic_id: relicId,
    body,
    display_name: 'Relic Agent',
  });
  assert.equal(written['isError'], false, JSON.stringify(written));
  const writtenContent = written['structuredContent'] as Record<
    string,
    unknown
  >;
  assert.equal(writtenContent['author'], 'publisher');
  const localState = await loadPublishState(relicId);
  assert.equal(acceptedToken, localState?.publish_token);
  console.log(
    `COMMENTED comment_id=${writtenContent['comment_id']} ` +
      `author=${writtenContent['author']}`
  );

  // What the operator holds. Nothing in it is the comment.
  const storedRows = await store.listComments(relicId);
  const storedRow = storedRows[0];
  assert.ok(storedRow);
  assert.ok(!storedRow.ciphertext.includes('chart'));
  assert.ok(!storedRow.ciphertext.includes('quarter'));
  console.log(
    `STORED_CIPHERTEXT ${storedRow.ciphertext.slice(0, 32)}... ` +
      `(${storedRow.ciphertext.length} chars, contains_plaintext=false)`
  );

  const read = await callFresh(READ_COMMENTS_TOOL_NAME, { relic_id: relicId });
  assert.equal(read['isError'], false, JSON.stringify(read));
  const readContent = read['structuredContent'] as Record<string, unknown>;
  assert.equal(readContent['count'], 1);
  assert.equal(readContent['unreadable_count'], 0);
  const comments = readContent['comments'] as Record<string, unknown>[];
  assert.equal(comments[0]?.['body'], body);
  assert.equal(comments[0]?.['display_name'], 'Relic Agent');
  assert.equal(comments[0]?.['author'], 'publisher');
  console.log(
    `READ_BACK count=${readContent['count']} ` +
      `author=${comments[0]?.['author']} body=${JSON.stringify(
        comments[0]?.['body']
      )}`
  );

  // A relic this machine never published: no key, no token, refused before any
  // network call.
  const elsewhere = await callFresh(READ_COMMENTS_TOOL_NAME, {
    relic_id: '01jw0000000000000000000000',
  });
  assert.equal(elsewhere['isError'], true);
  const elsewhereContent = elsewhere['structuredContent'] as Record<
    string,
    unknown
  >;
  assert.equal(elsewhereContent['code'], 'no_local_publish_state');
  const elsewhereText = JSON.stringify(elsewhere['content']);
  assert.match(elsewhereText, /published from another machine/);
  console.log(`REFUSED_ELSEWHERE code=${elsewhereContent['code']}`);

  // A share URL is never an argument, so the key never enters a transcript
  // for a comment.
  const urlAttempt = await callFresh(READ_COMMENTS_TOOL_NAME, {
    relic_id: published.url,
  });
  assert.equal(urlAttempt['isError'], true);
  assert.match(
    JSON.stringify(urlAttempt['content']),
    /never the share URL: the URL carries the key in its fragment/
  );
  console.log('REFUSED_URL_ARGUMENT code=no_local_publish_state');

  console.log('COMMENT_PATH_OK');
} finally {
  service.stop(true);
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
}
