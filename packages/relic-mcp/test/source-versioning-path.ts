import { fetchUpload } from './upload-fixture.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nodeFiles } from '../src/files.ts';
import type { PublishDeps } from '../src/publish.ts';
import { handleMessage, LOOKUP_TOOL_NAME, TOOL_NAME } from '../src/server.ts';
import { publishStatePath } from '../src/state.ts';

const SERVICE = 'https://relic.example';
const VERSION_HISTORY_DISCLOSURE =
  "Anyone holding a relic's link can fetch every version it has ever held, " +
  'so republishing does not withdraw earlier content.';
const runFile = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'relic-source-path-'));
process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');

function grantFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.hostname === 'storage.invalid' && init?.method === 'PUT') {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'path-challenge',
        size_limit_bytes: 1_000_000,
        size_basis: 'plaintext',
      });
    }
    if (url.pathname === '/api/grant') {
      return Response.json({
        publish_token: 'path-publish-token-kept-locally',
        upload_url: 'https://storage.invalid/upload/first',
        relic_expires_at: null,
        report_url: `${SERVICE}/abuse`,
        disclosure_url: `${SERVICE}/disclosure`,
      });
    }
    if (url.pathname.endsWith('/complete')) return Response.json({});
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await runFile('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

async function callInProcess(
  name: string,
  path: string,
  deps: PublishDeps
): Promise<Record<string, unknown>> {
  const response = await handleMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: { path } },
    },
    deps
  );
  assert.ok(response !== undefined);
  return response.result as Record<string, unknown>;
}

async function callFresh(
  name: string,
  path: string
): Promise<Record<string, unknown>> {
  const child = Bun.spawn(['bun', join(packageRoot, 'src', 'index.ts')], {
    cwd: packageRoot,
    env: {
      ...process.env,
      RELIC_CHROME_PATH: 'none',
      RELIC_SERVICE_ORIGIN: SERVICE,
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
      params: { name, arguments: { path } },
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
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

try {
  const repository = join(scratch, 'repository');
  const first = join(scratch, 'worktree-one');
  const second = join(scratch, 'worktree-two');
  await mkdir(join(repository, 'docs'), { recursive: true });
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Relic Path');
  await git(repository, 'config', 'user.email', 'relic@example.invalid');
  await writeFile(join(repository, 'docs', 'report.md'), '# path check\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'Seed report');
  await git(
    repository,
    'remote',
    'add',
    'origin',
    'git@github.com:TheBushidoCollective/Relic.git'
  );
  await git(repository, 'worktree', 'add', '-b', 'first', first, 'HEAD');
  await git(repository, 'worktree', 'add', '-b', 'second', second, 'HEAD');

  const deps: PublishDeps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: grantFetch(),
    upload: fetchUpload,
    clientName: 'relic-mcp/path-check',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test fake renderer',
    }),
  };
  const firstPath = join(first, 'docs', 'report.md');
  const secondPath = join(second, 'docs', 'report.md');
  const published = await callInProcess(TOOL_NAME, firstPath, deps);
  const publishedContent = published['structuredContent'] as Record<
    string,
    unknown
  >;
  const relicId = publishedContent['relic_id'];
  assert.equal(typeof relicId, 'string');
  console.log(`PUBLISHED relic_id=${relicId}`);
  const disclosure = (
    published['content'] as { type: string; text: string }[]
  ).find(({ text }) => text === VERSION_HISTORY_DISCLOSURE);
  assert.ok(disclosure);
  assert.deepEqual(disclosure, {
    type: 'text',
    text: VERSION_HISTORY_DISCLOSURE,
  });
  console.log(`PUBLISH_DISCLOSURE ${disclosure.text}`);

  const lookupResponse = await callFresh(LOOKUP_TOOL_NAME, secondPath);
  const lookupResult = lookupResponse['result'] as Record<string, unknown>;
  const lookupContent = lookupResult['structuredContent'] as Record<
    string,
    unknown
  >;
  assert.equal(lookupContent['relic_id'], relicId);
  assert.match(JSON.stringify(lookupResult['content']), /relic_republish/);
  console.log(`FRESH_LOOKUP relic_id=${lookupContent['relic_id']}`);

  const refusalResponse = await callFresh(TOOL_NAME, secondPath);
  const refusalResult = refusalResponse['result'] as Record<string, unknown>;
  const refusalContent = refusalResult['structuredContent'] as Record<
    string,
    unknown
  >;
  assert.equal(refusalResult['isError'], true);
  assert.equal(refusalContent['code'], 'source_already_published');
  assert.equal(refusalContent['relic_id'], relicId);
  const refusalText = JSON.stringify(refusalResult['content']);
  assert.match(refusalText, /relic_republish/);
  assert.match(
    refusalText,
    /a second URL that nobody holding the first one will ever see/
  );
  console.log(
    `REFUSED code=${refusalContent['code']} relic_id=${refusalContent['relic_id']}`
  );
  console.log('SOURCE_VERSIONING_PATH_OK');
} finally {
  delete process.env['RELIC_PUBLISH_STATE'];
  await rm(scratch, { recursive: true, force: true });
}
