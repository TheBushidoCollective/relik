import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const promptTool = new URL('../bin/autofix-fixture.ts', import.meta.url)
  .pathname;
const policyTool = new URL('../bin/autofix-check-canary.ts', import.meta.url)
  .pathname;
const source = 'packages/relic-format/src/autofix-canary.ts';
const regression = 'packages/relic-format/test/autofix-canary.test.ts';
let temp: string;
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'relik-canary-test-'));
});
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});
function diff(path: string): string {
  return `diff --git a/${path} b/${path}\nindex 3367afd..3e75765 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;
}
test('fixed fixture prompt names only the intended canary and its test', async () => {
  const output = join(temp, 'prompt');
  const run = spawnSync('bun', [promptTool, 'a'.repeat(40), output], {
    encoding: 'utf8',
  });
  expect(run.status).toBe(0);
  const text = await readFile(output, 'utf8');
  expect(text).toContain(source);
  expect(text).toContain(regression);
  expect(text).toContain('untrusted data');
});
test('canary policy accepts only its exact source and regression files', async () => {
  const path = join(temp, 'canary.diff');
  await writeFile(path, diff(source) + diff(regression));
  expect(spawnSync('bun', [policyTool, path]).status).toBe(0);
  await writeFile(
    path,
    diff(source) + diff(regression) + diff('packages/relic-format/src/other.ts')
  );
  expect(spawnSync('bun', [policyTool, path]).status).not.toBe(0);
  await writeFile(path, diff(source));
  expect(spawnSync('bun', [policyTool, path]).status).not.toBe(0);
});
