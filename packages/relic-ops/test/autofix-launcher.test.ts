import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { guardLauncherSource } from '../bin/autofix-workflow-guard.ts';

const source = await readFile(
  new URL('../../../.github/scripts/run-agent-container.sh', import.meta.url),
  'utf8'
);
test('launcher refuses mutations to container isolation and secret output controls', () => {
  expect(() => guardLauncherSource(source)).not.toThrow();
  const variants = [
    source.replace('--cap-drop ALL', '--privileged'),
    source.replace('--network "$network"', '--network host'),
    source.replace(
      'src=$agent_copy,dst=$agent',
      'src=$agent,dst=$agent,readonly'
    ),
    source.replace(
      'src=$agent_copy,dst=$agent',
      'src=$agent_copy,dst=$agent_copy'
    ),
    source.replace(
      'src=$agent_copy,dst=$agent"',
      'src=$agent_copy,dst=$agent,readonly"'
    ),
    source.replace(
      '--mount "type=bind,src=$agent_copy,dst=$agent"',
      '--mount "type=bind,src=$agent_copy,dst=$agent" \\\n  --mount "type=bind,src=$agent/agent.db,dst=/tmp/original,readonly"'
    ),
    source.replace(
      '--agent-dir "$agent" --runtime-dir',
      '--agent-dir "$agent_copy" --runtime-dir'
    ),
    source.replace('mkdir -m 700 "$agent_copy"', 'mkdir -m 777 "$agent_copy"'),
    source.replace(
      'install -m 0600 "$agent/$name" "$agent_copy/$name"',
      'install -m 0644 "$agent/$name" "$agent_copy/$name"'
    ),
    source.replace('chmod 0400 "$agent/$name"', 'chmod 0600 "$agent/$name"'),
    source.replace(
      'python3 "$RUNNER_TEMP/omp-runtime/runtime.py" verify',
      'python3 "$RUNNER_TEMP/omp-runtime/runtime.py" prepare'
    ),
    source.replace('! -S /var/run/docker.sock', 'true'),
    source.replace('! command -v sudo', 'true'),
    source.replace('--log-driver=none', '--log-driver=json-file'),
    source.replace('--ulimit fsize=1048576:1048576', ''),
    source.replace(
      '--env HOME=/home/agent',
      '--env GITHUB_TOKEN=x --env HOME=/home/agent'
    ),
    source.replace('docker network create --internal', 'docker network create'),
    source.replace('timeout --kill-after=5s 45m docker', 'docker'),
  ];
  for (const changed of variants) {
    expect(changed).not.toBe(source);
    expect(() => guardLauncherSource(changed)).toThrow();
  }
});

test('verifies the original and mounts only its writable mode-restricted copy', () => {
  const verify = source.indexOf(
    'python3 "$RUNNER_TEMP/omp-runtime/runtime.py" verify'
  );
  const copy = source.indexOf(
    'install -m 0600 "$agent/$name" "$agent_copy/$name"'
  );
  const mount = source.indexOf(
    '--mount "type=bind,src=$agent_copy,dst=$agent"'
  );
  expect(verify).toBeGreaterThanOrEqual(0);
  expect(copy).toBeGreaterThan(verify);
  expect(mount).toBeGreaterThan(copy);
  expect(source).not.toContain('src=$agent,dst=$agent');
  expect(source).toContain('chmod 0500 "$agent"');
});
