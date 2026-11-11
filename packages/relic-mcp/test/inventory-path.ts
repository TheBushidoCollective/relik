import { fetchUpload } from './upload-fixture.ts';
/**
 * The question this feature exists to answer, as a repeatable command.
 *
 *   bun test/inventory-path.ts
 *
 * Take a relic published long ago whose source path was never recorded, the
 * shape 37 of this machine's 41 relics are in, and walk the whole way from
 * "what did I publish" to "the same URL now serves something else". Every step
 * after the seed runs in a *fresh process* holding nothing but the state file,
 * because that is the situation a later session is actually in: no memory of
 * the id, no memory of the path, and no way to ask the service for either.
 *
 * The service is a real HTTP listener on loopback rather than a fetch stub, so
 * the fresh processes talk to it exactly as they would talk to Relic, byte
 * ranges included.
 *
 * No URL is printed. The fragment is the key, and a path script's output ends
 * up in logs and transcripts; that the URL never changed is reported as a
 * comparison instead.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { LIST_TOOL_NAME, SHOW_TOOL_NAME } from '../src/server.ts';
import { publishStatePath } from '../src/state.ts';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'relic-inventory-path-'));
process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');

const PUBLISH_TOKEN = 'inventory-path-publish-token';
const objects = new Map<string, Uint8Array>();
const versions = new Map<string, number>();
let rangedRequest: string | undefined;

const service = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const segments = url.pathname.split('/').filter((part) => part.length > 0);
    const relicId = segments[2];

    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'inventory-path-challenge',
        size_limit_bytes: 1_000_000,
        size_basis: 'plaintext',
      });
    }

    if (url.pathname === '/api/grant') {
      const body = (await request.json()) as Record<string, unknown>;
      const id = String(body['relic_id']);
      versions.set(id, 1);
      return Response.json({
        publish_token: PUBLISH_TOKEN,
        upload_url: `${origin()}/upload/${id}`,
        relic_expires_at: null,
        report_url: `${origin()}/abuse`,
        disclosure_url: `${origin()}/disclosure`,
      });
    }

    if (url.pathname.endsWith('/republish') && relicId !== undefined) {
      const body = (await request.json()) as Record<string, unknown>;
      // The token is the whole authorization, and it only exists on the
      // machine that published. A republish that skipped it would prove
      // nothing about the machine boundary.
      assert.equal(body['publish_token'], PUBLISH_TOKEN);
      const next = (versions.get(relicId) ?? 1) + 1;
      versions.set(relicId, next);
      return Response.json({
        upload_url: `${origin()}/upload/${relicId}/v${next}`,
        relic_expires_at: null,
        report_url: `${origin()}/abuse`,
        disclosure_url: `${origin()}/disclosure`,
      });
    }

    if (url.pathname.startsWith('/upload/') && request.method === 'PUT') {
      objects.set(
        url.pathname.slice('/upload/'.length),
        new Uint8Array(await request.arrayBuffer())
      );
      return new Response(null, { status: 200 });
    }

    if (url.pathname.endsWith('/complete')) return Response.json({});

    // The unmetered check the listing prefers once a name is known.
    if (url.pathname.endsWith('/comments')) return Response.json([]);

    if (url.pathname.endsWith('/mint') && relicId !== undefined) {
      const version = versions.get(relicId);
      if (version === undefined) {
        return Response.json(
          { code: 'relic_not_found', relic_id: relicId },
          { status: 404 }
        );
      }
      const key = version === 1 ? relicId : `${relicId}/v${version}`;
      const bytes = objects.get(key);
      assert.ok(bytes, `no object for ${key}`);
      return Response.json({
        url: `${origin()}/o/${key}`,
        url_expires_at: new Date(Date.now() + 900_000).toISOString(),
        relic_expires_at: null,
        object_length: bytes.length,
        object_crc32c: 'unused',
        mints_remaining: 199,
        version,
        current_version: version,
      });
    }

    if (url.pathname.startsWith('/o/')) {
      const bytes = objects.get(url.pathname.slice('/o/'.length));
      if (bytes === undefined) return new Response(null, { status: 404 });
      const range = request.headers.get('range');
      const match = range?.match(/^bytes=(\d+)-(\d+)$/);
      if (match?.[1] !== undefined && match[2] !== undefined) {
        rangedRequest = range ?? undefined;
        const start = Number(match[1]);
        const end = Math.min(Number(match[2]), bytes.length - 1);
        return new Response(
          bytes.slice(start, end + 1) as unknown as BodyInit,
          {
            status: 206,
          }
        );
      }
      return new Response(bytes as unknown as BodyInit, { status: 200 });
    }

    return new Response(null, { status: 404 });
  },
});

function origin(): string {
  return `http://127.0.0.1:${service.port}`;
}

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
      RELIC_METADATA_CACHE: join(scratch, 'metadata-cache.json'),
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

/**
 * Reduce the recorded entry to what a client older than this one wrote: the
 * key, the token, and the version. No filename, no timestamp, no source, and
 * no source index, so nothing but the relic itself knows what it is called.
 */
async function forgetEverythingButTheSecrets(relicId: string): Promise<void> {
  const path = publishStatePath();
  const file = JSON.parse(await readFile(path, 'utf8')) as {
    relics: Record<string, Record<string, unknown>>;
    sources?: Record<string, string>;
  };
  const entry = file.relics[relicId];
  assert.ok(entry);
  file.relics[relicId] = {
    key: entry['key'],
    publish_token: entry['publish_token'],
    version: entry['version'],
  };
  delete file.sources;
  await writeFile(path, JSON.stringify(file, null, 2));
}

try {
  const deps: PublishDeps = {
    serviceOrigin: origin(),
    relicOrigin: origin(),
    files: nodeFiles,
    fetch: globalThis.fetch,
    upload: fetchUpload,
    clientName: 'relic-mcp/inventory-path',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'inventory-path test runner',
    }),
  };

  const original = join(scratch, 'quarterly-review.md');
  await writeFile(original, '# quarterly review\n\nDraft one.\n');
  const published = await publish({ path: original }, deps);
  const relicId = published.relic_id;
  await forgetEverythingButTheSecrets(relicId);
  // The path is gone from state and from disk, exactly like a relic published
  // from a directory that no longer exists.
  await rm(original);
  console.log(`SEEDED_LEGACY relic_id=${relicId} source_recorded=false`);

  const listed = await callFresh(LIST_TOOL_NAME, {});
  assert.equal(listed['isError'], false, JSON.stringify(listed));
  const listing = listed['structuredContent'] as Record<string, unknown>;
  const rows = listing['relics'] as Record<string, unknown>[];
  assert.equal(listing['total'], 1);
  assert.equal(listing['findable_by_source'], 0);
  const row = rows[0];
  assert.ok(row);
  assert.equal(row['relic_id'], relicId);
  assert.equal(row['filename'], 'quarterly-review.md');
  assert.equal(row['filename_basis'], 'envelope');
  assert.equal(row['status'], 'reachable');
  console.log(
    `LISTED relic_id=${relicId} filename=${row['filename']} ` +
      `basis=${row['filename_basis']} findable_by_source=` +
      `${listing['findable_by_source']}`
  );

  // The name came out of the relic's first record, not the whole object.
  assert.equal(rangedRequest, 'bytes=0-65556');
  console.log(`RECOVERED_BY_RANGE ${rangedRequest}`);

  const shown = await callFresh(SHOW_TOOL_NAME, {
    relic_id: relicId,
    include_content: true,
  });
  assert.equal(shown['isError'], false, JSON.stringify(shown));
  const detail = shown['structuredContent'] as Record<string, unknown>;
  assert.equal(detail['content'], '# quarterly review\n\nDraft one.\n');
  assert.equal(detail['versions'], 1);
  assert.equal(detail['republish_call'], null);
  console.log(
    `READ_BACK versions=${detail['versions']} bytes=${detail['content_bytes']}`
  );

  // The edit an agent can only make honestly because it just read the current
  // content back.
  const edited = join(scratch, 'quarterly-review.md');
  await writeFile(
    edited,
    `${String(detail['content'])}\nDraft two, with the correction.\n`
  );
  const republished = await callFresh('relic_republish', {
    relic_id: relicId,
    path: edited,
  });
  assert.equal(republished['isError'], false, JSON.stringify(republished));
  const newVersion = republished['structuredContent'] as Record<
    string,
    unknown
  >;
  assert.equal(newVersion['version'], 2);
  console.log(`REPUBLISHED version=${newVersion['version']}`);

  const after = await callFresh(SHOW_TOOL_NAME, {
    relic_id: relicId,
    include_content: true,
  });
  const afterDetail = after['structuredContent'] as Record<string, unknown>;
  assert.equal(afterDetail['versions'], 2);
  assert.match(
    String(afterDetail['content']),
    /Draft two, with the correction/
  );
  // The whole point: same URL, new content. Compared rather than printed,
  // because the fragment is the key.
  assert.equal(afterDetail['share_url'], published.url);
  assert.equal(row['share_url'], published.url);
  console.log(
    `SAME_URL_NEW_CONTENT versions=${afterDetail['versions']} ` +
      'url_unchanged=true'
  );

  // A second listing costs nothing: the name is cached, and the cheap check
  // is what confirms the relic still answers.
  const relisted = await callFresh(LIST_TOOL_NAME, {});
  const second = relisted['structuredContent'] as Record<string, unknown>;
  assert.equal(second['opens_spent'], 0);
  const secondRow = (second['relics'] as Record<string, unknown>[])[0];
  assert.equal(secondRow?.['filename'], 'quarterly-review.md');
  console.log(`RELISTED opens_spent=${second['opens_spent']}`);

  const printed = JSON.stringify([listed, shown, after, relisted]);
  assert.ok(
    !printed.includes(PUBLISH_TOKEN),
    'a publish token reached tool output'
  );
  console.log('NO_TOKEN_IN_OUTPUT true');

  console.log('INVENTORY_PATH_OK');
} finally {
  service.stop(true);
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
}
