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
    source.replace('dst=$agent,readonly', 'dst=$agent'),
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
