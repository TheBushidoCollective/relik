import { readFile } from 'node:fs/promises';
import { checkPatch } from '../src/patch-policy.ts';

try {
  if (process.argv.length !== 3) throw new Error('arguments');
  const patch = new TextDecoder('utf-8', { fatal: true }).decode(
    await readFile(process.argv[2]!)
  );
  const summary = checkPatch(patch);
  const expected = [
    'packages/relic-format/src/autofix-canary.ts',
    'packages/relic-format/test/autofix-canary.test.ts',
  ];
  if (JSON.stringify([...summary.files].sort()) !== JSON.stringify(expected))
    throw new Error('paths');
} catch {
  process.stderr.write('Autofix canary refused\n');
  process.exitCode = 1;
}
