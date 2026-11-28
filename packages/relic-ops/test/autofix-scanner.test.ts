import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scanner = new URL('../bin/autofix-scan.ts', import.meta.url).pathname;
const secret = 'fixture-credential-8e615afcf016';
let dir: string;
let db: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relik-scan-test-'));
  db = join(dir, 'agent.db');
  const sqlite = new Database(db);
  sqlite.exec('CREATE TABLE auth_credentials (data TEXT)');
  sqlite
    .query('INSERT INTO auth_credentials VALUES (?)')
    .run(JSON.stringify({ access: secret }));
  sqlite.close();
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
async function scan(value: string) {
  const path = join(dir, 'patch.diff');
  await writeFile(
    path,
    `diff --git a/packages/relic-server/src/a.ts b/packages/relic-server/src/a.ts\nindex 3367afd..3e75765 100644\n--- a/packages/relic-server/src/a.ts\n+++ b/packages/relic-server/src/a.ts\n@@ -1 +1 @@\n-old\n+${value}\n`
  );
  return spawnSync('bun', [scanner, path, db], { encoding: 'utf8' });
}
test('accepts a safe diff without printing any credential', async () => {
  const result = await scan('new');
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(secret);
});
test('rejects a credential in the patch with a fixed message only', async () => {
  const result = await scan(secret);
  expect(result.status).not.toBe(0);
  expect(result.stderr.trim()).toBe('Autofix patch refused');
  expect(result.stdout + result.stderr).not.toContain(secret);
});
