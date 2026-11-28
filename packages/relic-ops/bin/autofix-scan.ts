import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { lstat, open, readFile, type FileHandle } from 'node:fs/promises';
import { checkPatch, hasCredential } from '../src/patch-policy.ts';

async function readDatabaseBytes(
  path: string,
  optional = false
): Promise<Buffer | undefined> {
  let file: FileHandle;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
  } catch (error) {
    if (
      optional &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'ENOENT'
    )
      return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 1_048_576)
      throw new Error('database bytes');
    const bytes = await file.readFile();
    if (bytes.length > 1_048_576) throw new Error('database bytes');
    return bytes;
  } finally {
    await file.close();
  }
}

try {
  if (process.argv.length !== 5) throw new Error('arguments');
  const patchPath = process.argv[2]!;
  const dbPaths = [process.argv[3]!, process.argv[4]!];
  const [patchStat, firstStat, secondStat] = await Promise.all([
    lstat(patchPath),
    lstat(dbPaths[0]!),
    lstat(dbPaths[1]!),
  ]);
  if (
    !patchStat.isFile() ||
    patchStat.size > 200_000 ||
    !firstStat.isFile() ||
    firstStat.size > 1_048_576 ||
    !secondStat.isFile() ||
    secondStat.size > 1_048_576 ||
    (firstStat.dev === secondStat.dev && firstStat.ino === secondStat.ino)
  )
    throw new Error('file');
  const patch = new TextDecoder('utf-8', { fatal: true }).decode(
    await readFile(patchPath)
  );
  checkPatch(patch);
  const values: unknown[] = [];
  for (const dbPath of dbPaths) {
    const raw = await readDatabaseBytes(dbPath);
    if (!raw) throw new Error('database bytes');
    values.push(raw);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const sidecar = await readDatabaseBytes(`${dbPath}${suffix}`, true);
      if (sidecar) values.push(sidecar);
    }
    const db = new Database(dbPath, { readonly: true, strict: true });
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
  }
  if (hasCredential(patch, values)) throw new Error('credential');
} catch {
  process.stderr.write('Autofix patch refused\n');
  process.exitCode = 1;
}
