import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
const script = new URL('../bin/autofix-pr-body.ts', import.meta.url).pathname;
const path = 'packages/relic-viewer/test/regression.test.ts';
const patch = `diff --git a/${path} b/${path}\nindex 3367afd..3e75765 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
const sha256 = createHash('sha256').update(patch).digest('hex');
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'relik-pr-body-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
test('body starts with the bot-check limitation, exact verified hash, run link and human action', async () => {
  const diff = join(dir, 'change.diff');
  const result = join(dir, 'result.json');
  const title = join(dir, 'title');
  const body = join(dir, 'body');
  const security = join(dir, 'security');
  await writeFile(diff, patch);
  await writeFile(
    result,
    `${JSON.stringify({
      status: 'pass',
      sha256,
      tests: [path],
      baselineFailures: 1,
      passed: 1,
    })}\n`
  );
  const run = spawnSync(
    'bun',
    [
      script,
      diff,
      result,
      '27',
      '1'.repeat(16),
      '12345',
      title,
      body,
      security,
    ],
    { encoding: 'utf8' }
  );
  expect(run.status).toBe(0);
  const output = await readFile(body, 'utf8');
  const first = output.split('\n').slice(0, 9).join('\n');
  expect(first).toContain('automatic PR checks do not run');
  expect(first).toContain('Targeted regression replay passed');
  expect(first).toContain('must not merge');
  expect(first).toContain('full CI');
  expect(first).not.toContain('Full verify passed');
  expect(first).toContain(
    'https://github.com/TheBushidoCollective/relik/actions/runs/12345'
  );
  expect(first).toContain(sha256);
  expect(first).toContain('close and reopen');
  expect(first).toContain('human');
});
