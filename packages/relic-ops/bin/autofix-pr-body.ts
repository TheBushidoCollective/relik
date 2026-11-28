import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { checkPatch } from '../src/patch-policy.ts';

function exact(
  value: unknown,
  keys: string[]
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
try {
  if (process.argv.length !== 10) throw new Error('arguments');
  const [
    patchPath,
    resultPath,
    number,
    fingerprint,
    runId,
    titlePath,
    bodyPath,
    securityPath,
  ] = process.argv.slice(2) as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    !/^[1-9]\d{0,9}$/.test(number) ||
    !/^[0-9a-f]{16}$/.test(fingerprint) ||
    !/^[1-9]\d{0,19}$/.test(runId)
  )
    throw new Error('arguments');
  const [stat, resultStat] = await Promise.all([
    lstat(patchPath),
    lstat(resultPath),
  ]);
  if (
    !stat.isFile() ||
    stat.size > 200_000 ||
    !resultStat.isFile() ||
    resultStat.size > 8192
  )
    throw new Error('file');
  const bytes = await readFile(patchPath);
  const summary = checkPatch(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  );
  const result: unknown = JSON.parse(await readFile(resultPath, 'utf8'));
  if (
    !exact(result, [
      'status',
      'sha256',
      'tests',
      'baselineFailures',
      'passed',
    ]) ||
    result.status !== 'pass' ||
    result.sha256 !== createHash('sha256').update(bytes).digest('hex') ||
    !Array.isArray(result.tests) ||
    JSON.stringify(result.tests) !== JSON.stringify(summary.tests) ||
    !Number.isSafeInteger(result.baselineFailures) ||
    (result.baselineFailures as number) < 1 ||
    !Number.isSafeInteger(result.passed) ||
    (result.passed as number) < 1
  )
    throw new Error('proof');
  const lines = [
    'GitHub automatic PR checks do not run for bot-created PRs.',
    `Targeted regression replay passed for patch SHA-256 \`${result.sha256}\`: https://github.com/TheBushidoCollective/relik/actions/runs/${runId}`,
    'A human must close and reopen the PR, or push to its branch, to start full CI on the PR ref.',
    'A human must not merge until full CI is green.',
    '',
    `Fixes error report #${number} (${fingerprint}).`,
    '',
    ...(summary.flagged.length
      ? [
          'Security review required for:',
          ...summary.flagged.map((path) => `- \`${path}\``),
          '',
        ]
      : []),
    'Changed files:',
    ...summary.files.map((path) => `- \`${path}\``),
    '',
    'Targeted tests:',
    ...summary.tests.map((path) => `- \`${path}\``),
    '',
    'The regression test failed against main and passed with this patch.',
    'A human must review and merge this PR. It will not merge automatically.',
    '',
    `Closes #${number}`,
    '',
  ];
  await writeFile(titlePath, `Fix error report ${fingerprint}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(bodyPath, lines.join('\n'), { flag: 'wx', mode: 0o600 });
  await writeFile(securityPath, summary.flagged.length ? 'yes\n' : 'no\n', {
    flag: 'wx',
    mode: 0o600,
  });
} catch {
  process.stderr.write('Autofix proposal refused\n');
  process.exitCode = 1;
}
