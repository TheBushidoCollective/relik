import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import {
  appendFile,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPatch } from '../src/patch-policy.ts';

const scanner = new URL('../bin/autofix-scan.ts', import.meta.url).pathname;
const secret = 'secret-data-aaaaa-ccccc';
const alternate = 'other-cred-aaaaa-bbbbb';
const tableSecret = 'table-cred-aaaaa-ccccc';
const rawSecret = 'raw-cred-bbbbb-ccccc';
const rawUnicode = '秘密的测试凭据数据秘密的测试凭据数据';
const refreshed = 'fresh-cred-aaaaa-ddddd';
const oldWalValue = 'wal-cred-bbbbb-ddddd';
let dir: string;
let db: string;
let writableDb: string;
let writableConnection: Database;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relik-scan-test-'));
  db = join(dir, 'agent.db');
  writableDb = join(dir, 'agent-writable.db');
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
  writableConnection = new Database(writableDb);
  writableConnection.exec(
    'PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE auth_credentials (data TEXT); CREATE TABLE extra (value TEXT)'
  );
  writableConnection
    .query('INSERT INTO auth_credentials VALUES (?)')
    .run(JSON.stringify({ access: oldWalValue }));
  writableConnection
    .query('UPDATE auth_credentials SET data = ?')
    .run(JSON.stringify({ access: refreshed }));
});
afterAll(async () => {
  writableConnection.close();
  await rm(dir, { recursive: true, force: true });
});
function diff(value: string): string {
  return `diff --git a/packages/relic-server/src/a.ts b/packages/relic-server/src/a.ts\nindex 3367afd..3e75765 100644\n--- a/packages/relic-server/src/a.ts\n+++ b/packages/relic-server/src/a.ts\n@@ -1 +1 @@\n-old\n+${value}\n`;
}
async function scan(value: string) {
  const path = join(dir, 'patch.diff');
  await writeFile(path, diff(value));
  return spawnSync('bun', [scanner, path, db, writableDb], {
    encoding: 'utf8',
  });
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

test('rejects final writable credentials, including deleted values still in the WAL', async () => {
  expect((await readFile(writableDb)).includes(Buffer.from(oldWalValue))).toBe(
    false
  );
  expect(
    (await readFile(`${writableDb}-wal`)).includes(Buffer.from(oldWalValue))
  ).toBe(true);
  for (const value of [refreshed, oldWalValue]) {
    expect(() => checkPatch(diff(value))).not.toThrow();
    const result = await scan(value);
    expect(result.status).not.toBe(0);
    expect(result.stderr.trim()).toBe('Autofix patch refused');
    expect(result.stdout + result.stderr).not.toContain(value);
  }
});

test('refuses a missing writable database rather than silently scanning the original alone', async () => {
  const path = join(dir, 'missing-copy.diff');
  await writeFile(path, diff('new'));
  const result = spawnSync('bun', [scanner, path, db], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr.trim()).toBe('Autofix patch refused');
});

test('refuses aliased databases and symlinked SQLite sidecars', async () => {
  const patchPath = join(dir, 'alias.diff');
  await writeFile(patchPath, diff('new'));
  const alias = join(dir, 'alias.db');
  await link(db, alias);
  const same = spawnSync('bun', [scanner, patchPath, db, alias], {
    encoding: 'utf8',
  });
  expect(same.status).not.toBe(0);
  expect(same.stderr.trim()).toBe('Autofix patch refused');

  const safeDb = join(dir, 'sidecar.db');
  const sqlite = new Database(safeDb);
  sqlite.exec('CREATE TABLE auth_credentials (data TEXT)');
  sqlite
    .query('INSERT INTO auth_credentials VALUES (?)')
    .run(JSON.stringify({ access: refreshed }));
  sqlite.close();
  await symlink(db, `${safeDb}-wal`);
  const linked = spawnSync('bun', [scanner, patchPath, db, safeDb], {
    encoding: 'utf8',
  });
  expect(linked.status).not.toBe(0);
  expect(linked.stderr.trim()).toBe('Autofix patch refused');
});

test('scans a read-only WAL-mode original without modifying it', async () => {
  const sourceDir = join(dir, 'readonly-source');
  await mkdir(sourceDir);
  const original = join(sourceDir, 'agent.db');
  const sqlite = new Database(original);
  sqlite.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE auth_credentials (data TEXT)'
  );
  sqlite
    .query('INSERT INTO auth_credentials VALUES (?)')
    .run(JSON.stringify({ access: secret }));
  sqlite.close();
  await chmod(original, 0o400);
  await chmod(sourceDir, 0o500);
  try {
    const patchPath = join(dir, 'readonly.diff');
    await writeFile(patchPath, diff('new'));
    const result = spawnSync(
      'bun',
      [scanner, patchPath, original, writableDb],
      { encoding: 'utf8' }
    );
    expect(result.status, result.stderr).toBe(0);
  } finally {
    await chmod(sourceDir, 0o700);
  }
});
