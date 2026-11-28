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
    replaySource.replace(/('--network',\s*)'none'/, "$1'host'"),
    replaySource.replace(/('--env',\s*)'LANG=C.UTF-8'/, "$1'GITHUB_TOKEN=x'"),
    replaySource.replace("'--read-only'", "'--privileged'"),
    replaySource.replace("'docker',", "'bash',"),
    replaySource.replace('! -S /var/run/docker.sock', 'true'),
    replaySource.replace('! command -v sudo', 'true'),
    replaySource.replace('passesOriginalTests(originalResult)', 'true'),
    replaySource.replace('constants.O_NOFOLLOW', '0'),
    replaySource.replace('constants.O_NONBLOCK', '0'),
    replaySource.replace("'ls-files'", "'status'"),
    replaySource.replace('.filter(isOriginalTestPath)', '.filter(() => true)'),
    replaySource.replace('originalPackages.every(', 'originalPackages.some('),
  ];
  for (const mutant of mutants) {
    expect(mutant).not.toBe(replaySource);
    expect(() => guardReplaySource(mutant)).toThrow();
  }
});
const mutations: Array<[string, (s: string) => string]> = [
  [
    'sandbox authentication action',
    (s) =>
      s.replace(
        '      - name: Exchange vault identity\n',
        '      - name: Exchange vault identity\n        uses: google-github-actions/auth@v2\n'
      ),
  ],
  [
    'untrusted vault exchange source',
    (s) =>
      s.replace(
        'run: python3 .github/scripts/autofix-vault-token.py',
        'run: python3 "$RUNNER_TEMP/autofix-work/.github/scripts/autofix-vault-token.py"'
      ),
  ],
  [
    'wrong vault provider',
    (s) =>
      s.replace(
        `OMP_VAULT_WIF_PROVIDER: \${{ vars.OMP_VAULT_WIF_PROVIDER }}`,
        `OMP_VAULT_WIF_PROVIDER: \${{ vars.WRONG_PROVIDER }}`
      ),
  ],
  [
    'vault credential printed',
    (s) =>
      s.replace(
        '          config="$RUNNER_TEMP/autofix-curl.conf"\n',
        '          config="$RUNNER_TEMP/autofix-curl.conf"\n          cat "$config"\n'
      ),
  ],
  [
    'vault credential cleanup removed',
    (s) =>
      s.replace(
        '"$RUNNER_TEMP/autofix-curl.conf" "$RUNNER_TEMP/autofix-index"',
        '"$RUNNER_TEMP/autofix-index"'
      ),
  ],
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

test('filer trigger, permissions, checkout and matrix reservation predicate are guarded', () => {
  const changes = [
    caller.replace('  schedule:\n', '  pull_request_target:\n  schedule:\n'),
    caller.replace('      contents: read', '      contents: write'),
    caller.replace(
      "    if: github.ref == 'refs/heads/main'\n",
      "    if: github.ref == 'refs/heads/main'\n    environment: production\n"
    ),
    caller.replace(`ref: \${{ github.sha }}`, `ref: \${{ github.head_ref }}`),
    caller.replace(
      "vars.ERROR_REPORTS_MODE == 'live' && (inputs.mode",
      'true && (inputs.mode'
    ),
  ];
  for (const changed of changes) {
    expect(changed).not.toBe(caller);
    expect(() => guard(reusable, changed)).toThrow();
  }
});

test('privileged checkout, scan root and disposable git objects are guarded', () => {
  const changes = [
    sandbox.replace(`ref: \${{ github.sha }}`, `ref: \${{ github.head_ref }}`),
    sandbox.replace(
      '      - name: Extract and scan untrusted patch\n',
      `      - name: Extract and scan untrusted patch\n        working-directory: \${{ runner.temp }}/autofix-work\n`
    ),
    sandbox.replace(
      'GIT_OBJECT_DIRECTORY="$RUNNER_TEMP/autofix-objects"',
      'GIT_OBJECT_DIRECTORY="$GITHUB_WORKSPACE/.git/objects"'
    ),
    sandbox.replace(
      'GIT_ALTERNATE_OBJECT_DIRECTORIES="$GITHUB_WORKSPACE/.git/objects"',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES=/tmp'
    ),
    sandbox.replace(
      `          FIXTURE: \${{ inputs.fixture }}\n        run: |\n          set -euo pipefail\n          mkdir -m 700 "$RUNNER_TEMP/autofix-safe"`,
      `          FIXTURE: \${{ inputs.fixture }}\n          GITHUB_WORKSPACE: /tmp/agent\n        run: |\n          set -euo pipefail\n          mkdir -m 700 "$RUNNER_TEMP/autofix-safe"`
    ),
    sandbox.replace(
      '          base="$(cat "$RUNNER_TEMP/autofix-base")"',
      '          cd "$RUNNER_TEMP/autofix-work"\n          base="$(cat "$RUNNER_TEMP/autofix-base")"'
    ),
    sandbox.replace(
      'export GIT_TERMINAL_PROMPT=0',
      'export GIT_TERMINAL_PROMPT=1'
    ),
    sandbox.replace('read-tree "$base" 2>/dev/null', 'read-tree "$base"'),
    sandbox.replace(
      'rm -rf -- "$RUNNER_TEMP/autofix-work" "$RUNNER_TEMP/autofix-objects"',
      'true'
    ),
    sandbox.replaceAll(
      "|| { echo 'Autofix cleanup refused' >&2; exit 1; }",
      '|| true'
    ),
    sandbox.replaceAll('--backend=copyfile', '--backend=hardlink'),
  ];
  for (const [index, changed] of changes.entries()) {
    expect(changed).not.toBe(sandbox);
    let refused = false;
    try {
      guard(reusable, caller, changed);
    } catch {
      refused = true;
    }
    expect(refused, `mutation ${index} was accepted`).toBe(true);
  }
  const changed = proposer.replace(
    `ref: \${{ github.sha }}`,
    `ref: \${{ github.head_ref }}`
  );
  expect(changed).not.toBe(proposer);
  expect(() => guard(reusable, caller, sandbox, changed)).toThrow();
});

test('workflow scans both original and final writable credentials and always cleans both', () => {
  const original = '"$RUNNER_TEMP/omp-agent/agent.db"';
  const writable = '"$RUNNER_TEMP/omp-agent-writable/agent.db"';
  const copy = '"$RUNNER_TEMP/omp-agent-writable"';
  expect(sandbox).toContain(`${original} ${writable}`);
  expect(sandbox).toContain(`rm -rf -- ${copy}`);
  for (const changed of [
    sandbox.replace(`${original} ${writable}`, original),
    sandbox.replace(`rm -rf -- ${copy}`, 'true'),
  ]) {
    expect(changed).not.toBe(sandbox);
    expect(() => guard(reusable, caller, changed)).toThrow();
  }
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
