import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { checkPatch } from '../src/patch-policy.ts';

try {
  if (
    process.argv.length !== 5 ||
    !['create', 'verify'].includes(process.argv[2]!)
  )
    throw new Error('arguments');
  const [, , mode, patchPath, metadataPath] = process.argv;
  const stat = await lstat(patchPath!);
  if (!stat.isFile() || stat.size > 200_000) throw new Error('file');
  const bytes = await readFile(patchPath!);
  const summary = checkPatch(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  );
  const metadata = JSON.stringify({
    exit: 0,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    files: summary.files.length,
  });
  if (mode === 'create')
    await writeFile(metadataPath!, `${metadata}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  else if ((await readFile(metadataPath!, 'utf8')) !== `${metadata}\n`)
    throw new Error('metadata');
} catch {
  process.stderr.write('Autofix patch refused\n');
  process.exitCode = 1;
}
