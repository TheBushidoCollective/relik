import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type RelicApp } from '../packages/relic-server/src/app.ts';
import { diskAssets } from '../packages/relic-server/src/assets.ts';
import { MemoryStorage } from '../packages/relic-server/src/storage.ts';
import { MemoryStore } from '../packages/relic-server/src/store.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const viewer = fileURLToPath(
  new URL('../packages/relic-viewer/dist/', import.meta.url)
);
const scratch = await mkdtemp(join(tmpdir(), 'relik-smoke-proof-'));
const tools = join(scratch, 'tools');
const logs = join(scratch, 'logs');
await mkdir(tools);
await mkdir(logs);
const curl = Bun.which('curl');
if (!curl) throw new Error('curl is required');
await writeFile(
  join(tools, 'curl'),
  `#!/usr/bin/env bash
if [[ -n "\${CURL_LOG:-}" ]]; then
  printf '%s\\0' "$@" >> "$CURL_LOG"
  printf '\\0' >> "$CURL_LOG"
fi
exec "$REAL_CURL" "$@"
`,
  { mode: 0o700 }
);
const sentinel = join(scratch, 'sentinel');
const legacyNames = [
  'health',
  'h',
  'root',
  'install',
  'policy',
  'policy-page',
  'abuse',
  'shell',
  'sh',
  'vh',
  'sandbox.html',
];
await writeFile(sentinel, 'untouched');
for (const name of legacyNames) await symlink(sentinel, join(scratch, name));
const requests: string[] = [];
let missingAsset = false;
let app: RelicApp;
const service = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (request.method !== 'GET')
      return new Response('Forbidden', { status: 403 });
    if (missingAsset && path === '/assets/viewer.js')
      return new Response('Missing', { status: 404 });
    return app.fetch(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const usercontent = `http://localhost:${service.port}`;
const retired = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: () => new Response('retired', { status: 503 }),
});
app = createApp({
  config: { serviceOrigin: origin, usercontentOrigin: usercontent },
  store: new MemoryStore(),
  storage: new MemoryStorage(),
  assets: diskAssets(viewer),
});
const env = {
  ...process.env,
  TMPDIR: scratch,
  PATH: `${tools}:${process.env.PATH ?? ''}`,
  REAL_CURL: curl,
  SERVICE: origin,
  ORIGIN: origin,
  USERCONTENT: usercontent,
  RUN_HOST: `http://127.0.0.1:${retired.port}`,
};
async function run(script: string, log?: string): Promise<number> {
  const child = Bun.spawn(['bash', script], {
    cwd: root,
    env: { ...env, ...(log ? { CURL_LOG: log } : {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) console.log(`expected or unexpected failure: ${out}\n${err}`);
  return code;
}
async function checkDestinations(logPaths: string[]) {
  const dirs = new Set<string>();
  for (const log of logPaths) {
    const args = (await readFile(log, 'utf8')).split('\0');
    const destinations: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? '';
      if (arg === '-o' || arg === '-D') destinations.push(args[++i] ?? '');
      else if (arg.startsWith('-o') || arg.startsWith('-D'))
        destinations.push(arg.slice(2));
    }
    const files = destinations.filter((path) => path !== '/dev/null');
    assert.ok(files.length > 0, 'no response destinations observed');
    const dir = dirname(files[0] ?? '');
    assert.equal(
      dirname(dir),
      scratch,
      `response outside private temp root: ${dir}`
    );
    assert.match(basename(dir), /^relik-(deploy|origin)-smoke\./);
    assert.ok(
      files.every((path) => dirname(path) === dir),
      'mixed response directories'
    );
    assert.ok(!dirs.has(dir), `directory reused: ${dir}`);
    dirs.add(dir);
  }
}
const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaa';
const cover = `/${id}/cover/${'0'.repeat(64)}.png`;
try {
  assert.equal(await run('scripts/deploy-smoke.sh'), 0);
  assert.equal(await run('scripts/origin-smoke.sh'), 0);
  const expected = [
    '/health',
    `/${id}`,
    '/assets/viewer.js',
    '/assets/landing-html.png',
    '/assets/landing-markdown.png',
    '/assets/landing-code-dark.png',
    '/assets/styles.css',
    '/assets/register-sw.js',
    '/manifest.webmanifest',
    '/sw.js',
    '/assets/icon.svg',
    '/',
    '/install',
    '/policy',
    '/policy',
    '/abuse',
    cover,
    '/assets/viewer.js',
    '/sandbox.html',
    `/${id}`,
    '/sandbox.html',
  ].map((path) => `GET ${path}`);
  assert.deepEqual(requests, expected);
  console.log('SMOKE_READ_ONLY_OK');
  requests.length = 0;
  const concurrentLogs = [0, 1, 2, 3].map((i) => join(logs, `concurrent-${i}`));
  const concurrent = await Promise.all([
    run('scripts/deploy-smoke.sh', concurrentLogs[0]),
    run('scripts/deploy-smoke.sh', concurrentLogs[1]),
    run('scripts/origin-smoke.sh', concurrentLogs[2]),
    run('scripts/origin-smoke.sh', concurrentLogs[3]),
  ]);
  assert.deepEqual(concurrent, [0, 0, 0, 0]);
  assert.deepEqual([...requests].sort(), [...expected, ...expected].sort());
  await checkDestinations(concurrentLogs);
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
  assert.deepEqual(
    (await readdir(scratch)).sort(),
    [...legacyNames, 'sentinel', 'tools', 'logs'].sort()
  );
  console.log('SMOKE_PRIVATE_TEMP_CONCURRENT_OK');
  const shared = join(scratch, 'relik-deploy-smoke.shared');
  await mkdir(shared);
  const deploySource = await readFile(
    join(root, 'scripts/deploy-smoke.sh'),
    'utf8'
  );
  const mutatedSource = deploySource
    .replace(
      'scratch="$(mktemp -d "${TMPDIR:-/tmp}/relik-deploy-smoke.XXXXXXXX")"',
      'scratch="$TMPDIR/relik-deploy-smoke.shared"'
    )
    .replace(`trap 'rm -rf -- "$scratch"' EXIT`, ':');
  assert.notEqual(mutatedSource, deploySource);
  const sharedMutant = join(scratch, 'shared-mutant.sh');
  await writeFile(sharedMutant, mutatedSource);
  const mutantLogs = [join(logs, 'shared-0'), join(logs, 'shared-1')];
  assert.equal(await run(sharedMutant, mutantLogs[0]), 0);
  assert.equal(await run(sharedMutant, mutantLogs[1]), 0);
  await assert.rejects(checkDestinations(mutantLogs), /directory reused/);
  console.log('SMOKE_SHARED_TEMP_MUTANT_REJECTED');
  for (const route of ['mint', 'cover']) {
    requests.length = 0;
    const source = await readFile(
      join(root, 'scripts/deploy-smoke.sh'),
      'utf8'
    );
    const mutant = join(scratch, `${route}.sh`);
    await writeFile(
      mutant,
      `${source}\ncurl -sS -X POST -o /dev/null "$SERVICE/api/relics/${id}/${route}"\n`
    );
    const exit = await run(mutant);
    assert.ok(
      exit !== 0 || requests.some((entry) => entry.startsWith('POST ')),
      `${route} mutation escaped proof`
    );
    assert.ok(
      requests.includes(`POST /api/relics/${id}/${route}`),
      `${route} mutation was not exercised`
    );
    assert.throws(() => assert.deepEqual(requests, expected.slice(0, 18)));
    console.log(`SMOKE_RESTORED_POST_REJECTED route=${route}`);
  }
  missingAsset = true;
  assert.notEqual(await run('scripts/deploy-smoke.sh'), 0);
  console.log('SMOKE_MISSING_ASSET_REJECTED');
  console.log('DEPLOY_SMOKE_PATH_OK');
} finally {
  service.stop(true);
  retired.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
