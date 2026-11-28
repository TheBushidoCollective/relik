import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPatch } from '../src/patch-policy.ts';

const scanner = new URL('../bin/autofix-scan.ts', import.meta.url).pathname;
const secret = 'secret-data-aaaaa-ccccc';
const alternate = 'other-cred-aaaaa-bbbbb';
const tableSecret = 'table-cred-aaaaa-ccccc';
const rawSecret = 'raw-cred-bbbbb-ccccc';
const rawUnicode = '秘密的测试凭据数据秘密的测试凭据数据';
let dir: string;
let db: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relik-scan-test-'));
  db = join(dir, 'agent.db');
  const sqlite = new Database(db);
  sqlite.exec(
    'CREATE TABLE auth_credentials (data TEXT, alternate TEXT); CREATE TABLE another (content BLOB)'
  );
  sqlite
    .query('INSERT INTO auth_credentials VALUES (?, ?)')
    .run(JSON.stringify({ access: secret }), alternate);
  sqlite.query('INSERT INTO another VALUES (?)').run(Buffer.from(tableSecret));
  sqlite.close();
  await appendFile(db, Buffer.alloc(20_000));
  await appendFile(db, `\0${rawSecret}\0${rawUnicode}\0`);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
function diff(value: string): string {
  return `diff --git a/packages/relic-server/src/a.ts b/packages/relic-server/src/a.ts\nindex 3367afd..3e75765 100644\n--- a/packages/relic-server/src/a.ts\n+++ b/packages/relic-server/src/a.ts\n@@ -1 +1 @@\n-old\n+${value}\n`;
}
async function scan(value: string) {
  const path = join(dir, 'patch.diff');
  await writeFile(path, diff(value));
  return spawnSync('bun', [scanner, path, db], { encoding: 'utf8' });
}
test('accepts a safe diff without printing any credential', async () => {
  const result = await scan('new');
  expect(result.status).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(secret);
});
test('rejects a credential in the patch with a fixed message only', async () => {
  expect(() => checkPatch(diff(secret))).not.toThrow();
  const result = await scan(secret);
  expect(result.status).not.toBe(0);
  expect(result.stderr.trim()).toBe('Autofix patch refused');
  expect(result.stdout + result.stderr).not.toContain(secret);
});
test('rejects values from other columns, other tables and raw database bytes', async () => {
  for (const value of [alternate, tableSecret, rawSecret]) {
    expect(() => checkPatch(diff(value))).not.toThrow();
    const result = await scan(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).toBe('Autofix patch refused');
    expect(result.stdout + result.stderr).not.toContain(value);
  }
});

test('rejects encoded UTF-8 credential text present only in raw database bytes', async () => {
  const value = (
    Buffer.from(rawUnicode)
      .toString('base64')
      .match(/.{1,8}/g) ?? []
  ).join("' + '");
  expect(() => checkPatch(diff(value))).not.toThrow();
  const result = await scan(value);
  expect(result.status).not.toBe(0);
  expect(result.stderr.trim()).toBe('Autofix patch refused');
});
