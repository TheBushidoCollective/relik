import { fetchUpload } from './upload-fixture.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { nodeFiles } from '../src/files.ts';
import { type PublishDeps, publish } from '../src/publish.ts';
import { republish } from '../src/republish.ts';
import { handleMessage, LOOKUP_TOOL_NAME, TOOL_NAME } from '../src/server.ts';
import {
  normalizeGitRemote,
  publishStatePath,
  resolveSourceIdentity,
} from '../src/state.ts';

const SERVICE = 'https://relic.example';
const runFile = promisify(execFile);
const packageRoot = fileURLToPath(new URL('../', import.meta.url));

let scratch: string;
let deps: PublishDeps;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relic-source-versioning-'));
  process.env['RELIC_PUBLISH_STATE'] = join(
    scratch,
    'state',
    'publish-state.json'
  );
  deps = {
    serviceOrigin: SERVICE,
    relicOrigin: SERVICE,
    files: nodeFiles,
    fetch: grantFetch(),
    upload: fetchUpload,
    clientName: 'relic-mcp/source-versioning-test',
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

function grantFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : String(input));
    if (url.hostname === 'storage.invalid' && init?.method === 'PUT') {
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/api/challenge') {
      return Response.json({
        challenge_nonce: 'test-challenge',
        size_limit_bytes: 10_000_000,
        size_basis: 'plaintext',
      });
    }
    if (url.pathname === '/api/grant') return Response.json(grant('first'));
    if (url.pathname.endsWith('/republish')) {
      return Response.json(grant('next'));
    }
    if (url.pathname.endsWith('/complete')) return Response.json({});
    if (url.pathname.endsWith('/comments')) return Response.json([]);
    return new Response(null, { status: 404 });
  }) as typeof globalThis.fetch;
}

function grant(version: string): Record<string, unknown> {
  return {
    publish_token: 'publish-token-held-only-in-local-state',
    upload_url: `https://storage.invalid/upload/${version}`,
    relic_expires_at: null,
    report_url: `${SERVICE}/abuse`,
    disclosure_url: `${SERVICE}/disclosure`,
  };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
  callDeps = deps
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

async function stateFile(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(publishStatePath(), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await runFile('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function makeRepository(
  withRemote = true
): Promise<{ first: string; second: string }> {
  const repository = join(scratch, 'repository');
  const first = join(scratch, 'worktree-one');
  const second = join(scratch, 'worktree-two');
  await mkdir(join(repository, 'docs'), { recursive: true });
  await git(repository, 'init', '-b', 'main');
  await git(repository, 'config', 'user.name', 'Relic Test');
  await git(repository, 'config', 'user.email', 'relic@example.invalid');
  await writeFile(join(repository, 'docs', 'report.md'), '# version one\n');
  await writeFile(join(repository, 'docs', 'other.md'), '# another file\n');
  await git(repository, 'add', '.');
  await git(repository, 'commit', '-m', 'Seed source files');
  if (withRemote) {
    await git(
      repository,
      'remote',
      'add',
      'origin',
      'git@github.com:TheBushidoCollective/Relic.git'
    );
  }
  await git(repository, 'worktree', 'add', '-b', 'first', first, 'HEAD');
  await git(repository, 'worktree', 'add', '-b', 'second', second, 'HEAD');
  return { first, second };
}

async function lookupInFreshProcess(path: string): Promise<{
  output: Record<string, unknown>;
  stderr: string;
  exit: number;
}> {
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
      params: {
        name: LOOKUP_TOOL_NAME,
        arguments: { path },
      },
    })}\n`
  );
  child.stdin.end();

  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    output: JSON.parse(stdout.trim()) as Record<string, unknown>,
    stderr,
    exit,
  };
}

describe('source identity', () => {
  test('normalizes equivalent SSH and HTTPS remotes to one repository', () => {
    expect(normalizeGitRemote('git@github.com:Org/Repo.git')).toBe(
      'github.com/org/repo'
    );
    expect(normalizeGitRemote('https://github.com/org/repo')).toBe(
      'github.com/org/repo'
    );
    expect(normalizeGitRemote('jason@sourcehut.org:Org/Repo.git')).toBe(
      'sourcehut.org/org/repo'
    );
    expect(normalizeGitRemote('https://sourcehut.org/org/repo')).toBe(
      'sourcehut.org/org/repo'
    );
  });

  test('normalizes file URLs and absolute path remotes alike', () => {
    expect(normalizeGitRemote('file:///tmp/example/repo.git')).toBe(
      normalizeGitRemote('/tmp/example/repo.git')
    );
  });

  test('uses the shared Git common directory when no remote exists', async () => {
    const { first, second } = await makeRepository(false);
    const firstSource = await resolveSourceIdentity(
      join(first, 'docs', 'report.md')
    );
    const secondSource = await resolveSourceIdentity(
      join(second, 'docs', 'report.md')
    );

    expect(firstSource.kind).toBe('git_common_dir');
    expect(secondSource).toEqual(firstSource);
  });

  test('does not collide two different files in one repository', async () => {
    const { first, second } = await makeRepository();
    const report = await publish(
      { path: join(first, 'docs', 'report.md') },
      deps
    );
    const other = await publish(
      { path: join(second, 'docs', 'other.md') },
      deps
    );

    expect(other.relic_id).not.toBe(report.relic_id);
    expect(Object.keys((await stateFile())['relics'] as object)).toHaveLength(
      2
    );
  });

  test('uses realpath outside Git so a symlink cannot hide a prior publish', async () => {
    const realDirectory = join(scratch, 'outside', 'real');
    const aliasDirectory = join(scratch, 'outside', 'alias');
    const source = join(realDirectory, 'report.md');
    const alias = join(aliasDirectory, 'report.md');
    await mkdir(realDirectory, { recursive: true });
    await writeFile(source, '# first\n');
    await symlink(realDirectory, aliasDirectory);
    const first = await publish({ path: source }, deps);

    const refused = await callTool(TOOL_NAME, { path: alias });
    expect(refused['isError']).toBe(true);
    expect(
      (refused['structuredContent'] as Record<string, unknown>)['relic_id']
    ).toBe(first.relic_id);
  });
});

describe('prior publish steering', () => {
  test('detects the same source across two worktrees and looks it up in a fresh process', async () => {
    const { first, second } = await makeRepository();
    const firstPath = join(first, 'docs', 'report.md');
    const secondPath = join(second, 'docs', 'report.md');
    const published = await publish({ path: firstPath }, deps);

    const fresh = await lookupInFreshProcess(secondPath);
    expect({ exit: fresh.exit, stderr: fresh.stderr }).toEqual({
      exit: 0,
      stderr: '',
    });
    const lookupResult = fresh.output['result'] as Record<string, unknown>;
    expect(
      (lookupResult['structuredContent'] as Record<string, unknown>)['relic_id']
    ).toBe(published.relic_id);

    const refused = await callTool(TOOL_NAME, { path: secondPath });
    const structured = refused['structuredContent'] as Record<string, unknown>;
    expect(refused['isError']).toBe(true);
    expect(structured).toMatchObject({
      code: 'source_already_published',
      relic_id: published.relic_id,
      version: 1,
      republish_call: {
        name: 'relic_republish',
        arguments: { relic_id: published.relic_id, path: secondPath },
      },
    });
    expect(JSON.stringify(refused['content'])).toContain(published.relic_id);
    expect(JSON.stringify(refused['content'])).toContain('relic_republish');
    expect(JSON.stringify(refused['content'])).toContain(
      'a second URL that nobody holding the first one will ever see'
    );
  });

  test('force_new publishes a separate relic and keeps both entries', async () => {
    const path = join(scratch, 'report.md');
    await writeFile(path, '# first\n');
    const first = await publish({ path }, deps);
    const forced = await callTool(TOOL_NAME, { path, force_new: true });
    const second = forced['structuredContent'] as Record<string, unknown>;

    expect(forced['isError']).toBe(false);
    expect(second['relic_id']).not.toBe(first.relic_id);
    const stored = await stateFile();
    const relics = stored['relics'] as Record<string, Record<string, unknown>>;
    expect(Object.keys(relics)).toHaveLength(2);
    expect(relics[first.relic_id]?.['source']).toBeDefined();
    expect(relics[String(second['relic_id'])]?.['source']).toBeDefined();
  });

  test('legacy state without source identity still republishes and permits a new publish', async () => {
    const path = join(scratch, 'legacy.md');
    await writeFile(path, '# first\n');
    const first = await publish({ path }, deps);
    const stored = await stateFile();
    const relics = stored['relics'] as Record<string, Record<string, unknown>>;
    delete relics[first.relic_id]?.['source'];
    relics[first.relic_id] = {
      ...relics[first.relic_id],
      future_entry_field: 'preserve me',
    };
    delete stored['sources'];
    stored['future_root_field'] = { preserve: true };
    await writeFile(
      publishStatePath(),
      `${JSON.stringify(stored, null, 2)}\n`,
      { mode: 0o600 }
    );

    // Changed content, because an identical republish is refused on its own
    // grounds and this test is about legacy state surviving one.
    await writeFile(path, '# second\n');
    const updated = await republish({ relic_id: first.relic_id, path }, deps);
    expect(updated.version).toBe(2);
    const separate = await publish({ path }, deps);
    expect(separate.relic_id).not.toBe(first.relic_id);

    const after = await stateFile();
    const afterRelics = after['relics'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(after['future_root_field']).toEqual({ preserve: true });
    expect(afterRelics[first.relic_id]?.['future_entry_field']).toBe(
      'preserve me'
    );
    expect(Object.keys(afterRelics)).toHaveLength(2);
  });
});
