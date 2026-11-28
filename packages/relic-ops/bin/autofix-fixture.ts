import { readFile, writeFile } from 'node:fs/promises';
import type { Issue } from '../src/github.ts';
import { issueInput } from '../src/issue-input.ts';
import { makePrompt } from '../src/prompt.ts';
import { parseRegion } from '../src/render.ts';

try {
  if (process.argv.length !== 4 || !/^[0-9a-f]{40}$/.test(process.argv[2]!))
    throw new Error('arguments');
  const issue = JSON.parse(
    await readFile(
      new URL('../fixtures/autofix/issue.json', import.meta.url),
      'utf8'
    )
  ) as Issue;
  const report = parseRegion(issue.body);
  if (report === null) throw new Error('fixture');
  const accepted = issueInput(
    issue,
    { issue: 1, fingerprint: report.fingerprint },
    {
      commitDate: () => '2026-01-01T00:00:00Z',
      serverFrameExists: () => true,
    }
  );
  const prompt = `${makePrompt(accepted, process.argv[2]!)}\n\nThis is the fixed regression canary. In packages/relic-format/src/autofix-canary.ts, autofixCanary must return its input unchanged. Write the failing test as packages/relic-format/test/autofix-canary.test.ts and fix the function. Change only those two files.\n`;
  await writeFile(process.argv[3]!, prompt, { mode: 0o600, flag: 'wx' });
} catch {
  process.stderr.write('Autofix fixture refused\n');
  process.exitCode = 1;
}
