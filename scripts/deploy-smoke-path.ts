import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { MemoryStorage } from '@relic/server/src/storage.ts';
import { MemoryStore } from '@relic/server/src/store.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const viewer = fileURLToPath(
  new URL('../packages/relic-viewer/dist/', import.meta.url)
);
const scratch = await mkdtemp(join(tmpdir(), 'relik-smoke-proof-'));
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
  SERVICE: origin,
  ORIGIN: origin,
  USERCONTENT: usercontent,
  RUN_HOST: `http://127.0.0.1:${retired.port}`,
};
async function run(script: string): Promise<number> {
  const child = Bun.spawn(['bash', script], {
    cwd: root,
    env,
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
