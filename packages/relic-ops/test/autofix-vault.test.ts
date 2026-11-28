import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('direct vault federation uses both HTTP exchanges without exposing tokens', () => {
  const fixture = new URL('./autofix-vault-fixture.py', import.meta.url);
  const result = spawnSync('python3', [fixture.pathname], { encoding: 'utf8' });
  expect(result.status).toBe(0);
});

test('vault exchange CLI refuses missing runner identity without outputting it', () => {
  const script = new URL(
    '../../../.github/scripts/autofix-vault-token.py',
    import.meta.url
  );
  const result = spawnSync('python3', [script.pathname], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('Vault authentication refused\n');
});

test('vault fetch deletes its private config on success and failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relik-vault-fetch-'));
  try {
    const bin = join(root, 'bin');
    const runner = join(root, 'runner');
    await mkdir(bin);
    await mkdir(runner);
    const curl = join(bin, 'curl');
    await writeFile(
      curl,
      `#!/bin/bash
set -euo pipefail
[[ -f "$RUNNER_TEMP/autofix-curl.conf" ]]
calls="$RUNNER_TEMP/calls"
number=0
[[ ! -e "$calls" ]] || number="$(<"$calls")"
number=$((number + 1))
printf '%s' "$number" > "$calls"
[[ "$number" != "$FAIL_CALL" ]] || exit 7
while (( $# )); do
  if [[ "$1" == --output ]]; then shift; : > "$1"; fi
  shift
done
`
    );
    await chmod(curl, 0o700);
    const workflow = Bun.YAML.parse(
      await readFile(
        new URL(
          '../../../.github/workflows/autofix-sandbox.yml',
          import.meta.url
        ),
        'utf8'
      )
    ) as {
      jobs: { sandbox: { steps: Array<{ name?: string; run?: string }> } };
    };
    const fetch = workflow.jobs.sandbox.steps.find(
      (step) => step.name === 'Fetch pinned context and credential'
    );
    expect(fetch?.run).toBeDefined();
    for (const [failCall, bucket, status] of [
      ['0', 'fixture-bucket', 0],
      ['1', 'fixture-bucket', 1],
      ['2', 'fixture-bucket', 1],
      ['0', 'invalid bucket', 1],
    ] as const) {
      await rm(join(runner, 'calls'), { force: true });
      const config = join(runner, 'autofix-curl.conf');
      await writeFile(config, 'fixture credential', { mode: 0o600 });
      const result = spawnSync('bash', ['-c', fetch!.run!], {
        cwd: new URL('../../../', import.meta.url).pathname,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: runner,
          VAULT_BUCKET: bucket,
          FAIL_CALL: failCall,
        },
        encoding: 'utf8',
      });
      expect(result.status).toBe(status);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(
        failCall === '0' ? '' : 'Vault download refused\n'
      );
      expect(existsSync(config)).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
