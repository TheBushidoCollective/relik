import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = Bun.YAML.parse(
  await readFile(
    new URL('../../../.github/workflows/autofix-sandbox.yml', import.meta.url),
    'utf8'
  )
) as {
  jobs: {
    sandbox: { steps: Array<{ name?: string; if?: string; run?: string }> };
  };
};
const step = workflow.jobs.sandbox.steps.find(
  (item) => item.name === 'Remove credential material'
);

test('always cleanup removes read-only original and writable copy without following links', async () => {
  expect(step?.if).toBe('always()');
  const root = await mkdtemp(join(tmpdir(), 'relik-agent-cleanup-'));
  try {
    const runner = join(root, 'runner');
    const workspace = join(root, 'workspace');
    const original = join(runner, 'omp-agent');
    const copy = join(runner, 'omp-agent-writable');
    await mkdir(original, { recursive: true });
    await mkdir(copy, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(original, 'agent.db'), 'fixture credential');
    await chmod(join(original, 'agent.db'), 0o400);
    await chmod(original, 0o500);
    await writeFile(join(copy, 'agent.db'), 'fixture refreshed credential');
    await writeFile(join(runner, 'autofix-curl.conf'), 'fixture credential');
    const outside = join(root, 'outside');
    await writeFile(outside, 'untouched');
    await chmod(outside, 0o400);
    await symlink(outside, join(copy, 'outside-link'));
    await chmod(copy, 0o000);
    const result = spawnSync('bash', ['-e', '-c', step!.run!], {
      env: { ...process.env, RUNNER_TEMP: runner, GITHUB_WORKSPACE: workspace },
      encoding: 'utf8',
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(original)).toBe(false);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(join(runner, 'autofix-curl.conf'))).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe('untouched');
    expect((await stat(outside)).mode & 0o777).toBe(0o400);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
