import { Database } from 'bun:sqlite';
import { lstat, readFile } from 'node:fs/promises';
import { checkPatch, hasCredential } from '../src/patch-policy.ts';

try {
  if (process.argv.length !== 4) throw new Error('arguments');
  const patchPath = process.argv[2]!;
  const dbPath = process.argv[3]!;
  const [patchStat, dbStat] = await Promise.all([
    lstat(patchPath),
    lstat(dbPath),
  ]);
  if (
    !patchStat.isFile() ||
    patchStat.size > 200_000 ||
    !dbStat.isFile() ||
    dbStat.size > 1_048_576
  )
    throw new Error('file');
  const patch = new TextDecoder('utf-8', { fatal: true }).decode(
    await readFile(patchPath)
  );
  checkPatch(patch);
  const db = new Database(dbPath, { readonly: true, strict: true });
  let rows: unknown[];
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
    rows = db.query('SELECT data FROM auth_credentials').all();
  } finally {
    db.close();
  }
  if (
    rows.length !== 1 ||
    typeof rows[0] !== 'object' ||
    rows[0] === null ||
    !('data' in rows[0]) ||
    typeof rows[0].data !== 'string' ||
    !rows[0].data
  )
    throw new Error('database');
  if (hasCredential(patch, [rows[0].data])) throw new Error('credential');
} catch {
  process.stderr.write('Autofix patch refused\n');
  process.exitCode = 1;
}
