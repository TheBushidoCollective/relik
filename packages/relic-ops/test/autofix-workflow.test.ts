import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import {
  guardReplaySource,
  guardWorkflows,
} from '../bin/autofix-workflow-guard.ts';

const reusable = await readFile(
  new URL('../../../.github/workflows/autofix.yml', import.meta.url),
  'utf8'
);
const caller = await readFile(
  new URL('../../../.github/workflows/error-reports.yml', import.meta.url),
  'utf8'
);
const sandbox = await readFile(
  new URL('../../../.github/workflows/autofix-sandbox.yml', import.meta.url),
  'utf8'
);
const proposer = await readFile(
  new URL('../../../.github/workflows/autofix-propose.yml', import.meta.url),
  'utf8'
);
const canary = await readFile(
  new URL('../../../.github/workflows/autofix-canary.yml', import.meta.url),
  'utf8'
);
const replaySource = await readFile(
  new URL('../bin/autofix-repro.ts', import.meta.url),
  'utf8'
);
const guard = (
  r = reusable,
  c = caller,
  s = sandbox,
  p = proposer,
  k = canary
) => guardWorkflows(r, c, s, p, k);
test('workflow permissions, artifact paths and trust boundaries are pinned', () => {
  expect(() => guard()).not.toThrow();
});

test('main-ref test job never runs patched code on its host', () => {
  expect(sandbox).not.toContain('mise exec node@24.15.0 -- mise run verify');
  expect(sandbox).not.toContain('cd "$RUNNER_TEMP/autofix-verify-work"');
});

test('replay wrapper refuses mutations that expose the host or credentials', () => {
  expect(() => guardReplaySource(replaySource)).not.toThrow();
  const mutants = [
    replaySource.replace(
      "'--network',\n          'none'",
      "'--network',\n          'host'"
    ),
    replaySource.replace(
      "'--env',\n          'LANG=C.UTF-8'",
      "'--env',\n          'GITHUB_TOKEN=x'"
    ),
    replaySource.replace("'--read-only'", "'--privileged'"),
    replaySource.replace("'docker',", "'bash',"),
    replaySource.replace('! -S /var/run/docker.sock', 'true'),
    replaySource.replace('! command -v sudo', 'true'),
  ];
  for (const mutant of mutants) {
    expect(mutant).not.toBe(replaySource);
    expect(() => guardReplaySource(mutant)).toThrow();
  }
});
const mutations: Array<[string, (s: string) => string]> = [
  [
    'environment',
    (s) =>
      s.replace(
        '    runs-on: ubuntu-24.04',
        '    environment: production\n    runs-on: ubuntu-24.04'
      ),
  ],
  [
    'sandbox repo write',
    (s) =>
      s.replace(
        '      contents: read\n      id-token: write',
        '      contents: write\n      id-token: write'
      ),
  ],
  [
    'test id-token',
    (s) =>
      s
        .replace('  test:\n', '  test:\n')
        .replace(
          '    permissions:\n      contents: read\n    steps:',
          '    permissions:\n      contents: read\n      id-token: write\n    steps:'
        ),
  ],
  [
    'agent token',
    (s) =>
      s.replace(
        '      - name: Run isolated fixer\n',
        '      - name: Run isolated fixer\n        env:\n          GITHUB_TOKEN: x\n'
      ),
  ],
  ['test cache', (s) => s.replaceAll('cache: false', 'cache: true')],
  [
    'host executes patched tests',
    (s) =>
      s.replace(
        '      - name: Verify patch and run targeted replay\n',
        '      - name: Execute patch on host\n        run: bun packages/relic-viewer/test/evil.test.ts\n      - name: Verify patch and run targeted replay\n'
      ),
  ],
  [
    'host executes patched script in replay step',
    (s) =>
      s.replace(
        '          mkdir -m 700 "$RUNNER_TEMP/autofix-result"\n',
        '          mkdir -m 700 "$RUNNER_TEMP/autofix-result"\n          bun "$RUNNER_TEMP/autofix-work/packages/relic-viewer/src/evil.ts"\n'
      ),
  ],
  [
    'host executes patched script in scan step',
    (s) =>
      s.replace(
        '          bun packages/relic-ops/bin/autofix-scan.ts ',
        '          bun "$RUNNER_TEMP/autofix-work/packages/relic-viewer/src/evil.ts"\n          bun packages/relic-ops/bin/autofix-scan.ts '
      ),
  ],
  [
    'host executes patched script while restoring canary',
    (s) =>
      s.replace(
        '          mkdir -m 700 "$RUNNER_TEMP/autofix-safe"\n',
        '          mkdir -m 700 "$RUNNER_TEMP/autofix-safe"\n          bun "$RUNNER_TEMP/autofix-work/packages/relic-viewer/src/evil.ts"\n'
      ),
  ],
  [
    'database artifact',
    (s) =>
      s.replace(
        `\${{ runner.temp }}/autofix-safe/patch.diff\n`,
        `\${{ runner.temp }}/omp-agent/agent.db\n`
      ),
  ],
  [
    'artifact wildcard',
    (s) =>
      s.replace(
        `\${{ runner.temp }}/autofix-safe/patch.diff\n`,
        `\${{ runner.temp }}/autofix-safe/**\n`
      ),
  ],
  [
    'pull request target',
    (s) =>
      s.replace(
        '  workflow_call:\n',
        '  pull_request_target:\n  workflow_call:\n'
      ),
  ],
  [
    'manual dispatch',
    (s) =>
      s.replace(
        '  workflow_call:\n',
        '  workflow_dispatch:\n  workflow_call:\n'
      ),
  ],
  [
    'missing main ref',
    (s) => s.replace("github.ref == 'refs/heads/main' && ", ''),
  ],
];
for (const [name, mutate] of mutations)
  test(`rejects workflow mutation: ${name}`, () => {
    const changed = mutate(sandbox);
    expect(changed).not.toBe(sandbox);
    expect(() => guard(reusable, caller, changed)).toThrow();
  });
test('refuses disabling live or autofix gating in the caller', () => {
  const altered = caller.replace("vars.AUTOFIX_MODE == 'on'", 'true');
  expect(altered).not.toBe(caller);
  expect(() => guard(reusable, altered)).toThrow();
});

test('refuses a proposer with id-token or execution of patched code', () => {
  const permissions = proposer.replace(
    '      pull-requests: write\n    steps:',
    '      pull-requests: write\n      id-token: write\n    steps:'
  );
  const execution = proposer.replace(
    '          set -euo pipefail\n          node packages/relic-ops/bin/autofix-check-patch',
    '          set -euo pipefail\n          bun packages/relic-viewer/src/evil.ts\n          node packages/relic-ops/bin/autofix-check-patch'
  );
  for (const changed of [permissions, execution]) {
    expect(changed).not.toBe(proposer);
    expect(() => guard(reusable, caller, sandbox, changed)).toThrow();
  }
});

test('read-only test job rejects setup-action caches', () => {
  const start = sandbox.indexOf('\n  test:\n');
  const before = sandbox.slice(0, start);
  const after = sandbox
    .slice(start)
    .replace(
      '      - name: Install trusted dependencies and build sandbox',
      '      - uses: actions/setup-node@v4\n        with:\n          cache: npm\n      - name: Install trusted dependencies and build sandbox'
    );
  const changed = before + after;
  expect(changed).not.toBe(sandbox);
  expect(() => guard(reusable, caller, changed)).toThrow();
});

test('canary has no proposer, repository writes or path into proposal', () => {
  const mutants = [
    canary.replace(
      '  canary:\n',
      '  propose:\n    runs-on: ubuntu-latest\n    steps: []\n  canary:\n'
    ),
    canary.replace('      contents: read', '      contents: write'),
    canary.replace(
      './.github/workflows/autofix-sandbox.yml',
      './.github/workflows/autofix-propose.yml'
    ),
  ];
  for (const changed of mutants) {
    expect(changed).not.toBe(canary);
    expect(() => guard(reusable, caller, sandbox, proposer, changed)).toThrow();
  }
});
