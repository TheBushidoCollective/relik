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
  const values: unknown[] = [];
  let foundCredentials = false;
  try {
    db.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF');
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all();
    if (tables.length > 128) throw new Error('database');
    for (const table of tables) {
      if (
        !table ||
        typeof table !== 'object' ||
        !('name' in table) ||
        typeof table.name !== 'string'
      )
        throw new Error('database');
      const name = `"${table.name.replaceAll('"', '""')}"`;
      const rows = db.query(`SELECT * FROM ${name}`).all();
      if (table.name === 'auth_credentials') {
        const row = rows[0];
        foundCredentials =
          rows.length === 1 &&
          !!row &&
          typeof row === 'object' &&
          'data' in row &&
          typeof row.data === 'string' &&
          row.data.length > 0;
      }
      values.push(...rows);
    }
  } finally {
    db.close();
  }
  if (!foundCredentials) throw new Error('database');
  values.push(await readFile(dbPath));
  if (hasCredential(patch, values)) throw new Error('credential');
} catch {
  process.stderr.write('Autofix patch refused\n');
  process.exitCode = 1;
}
