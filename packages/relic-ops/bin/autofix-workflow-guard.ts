type ObjectMap = Record<string, unknown>;
function object(value: unknown): ObjectMap {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Workflow refused');
  return value as ObjectMap;
}
function requireIt(value: unknown): asserts value {
  if (!value) throw new Error('Workflow refused');
}
function same(value: unknown, expected: ObjectMap): boolean {
  const input = object(value);
  return (
    Object.keys(input).sort().join(',') ===
      Object.keys(expected).sort().join(',') &&
    Object.keys(expected).every((key) => input[key] === expected[key])
  );
}
function steps(job: ObjectMap): ObjectMap[] {
  requireIt(Array.isArray(job.steps));
  return job.steps.map(object);
}
function stepByName(job: ObjectMap, name: string): ObjectMap {
  const matches = steps(job).filter((step) => step.name === name);
  requireIt(matches.length === 1);
  return matches[0]!;
}
function exactPath(step: ObjectMap, paths: string[]): void {
  const withOptions = object(step.with);
  requireIt(typeof withOptions.path === 'string');
  requireIt(
    withOptions.path
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .join('\n') === paths.join('\n')
  );
}

function guardTrustedCheckout(job: ObjectMap): void {
  requireIt(!('defaults' in job) && !('env' in job));
  const all = steps(job);
  for (const step of all) {
    requireIt(!('working-directory' in step));
    if (step.env !== undefined) {
      const env = object(step.env);
      requireIt(!('GITHUB_WORKSPACE' in env) && !('RUNNER_TEMP' in env));
    }
  }
  const checkouts = all.filter((step) => step.uses === 'actions/checkout@v4');
  requireIt(checkouts.length === 1);
  const checkout = object(checkouts[0]!.with);
  requireIt(
    checkout.ref === `\${{ github.sha }}` &&
      checkout['persist-credentials'] === false
  );
}

/** Reject unsafe workflow variants; test mutations exercise each boundary. */
export function guardWorkflows(
  orchestratorYaml: string,
  callerYaml: string,
  sandboxYaml: string,
  proposerYaml: string,
  canaryYaml: string
): void {
  const orchestrator = object(Bun.YAML.parse(orchestratorYaml));
  const caller = object(Bun.YAML.parse(callerYaml));
  const runner = object(Bun.YAML.parse(sandboxYaml));
  const proposal = object(Bun.YAML.parse(proposerYaml));
  const canary = object(Bun.YAML.parse(canaryYaml));
  for (const workflow of [orchestrator, caller, runner, proposal, canary])
    requireIt(!('defaults' in workflow));
  for (const workflow of [orchestrator, runner, proposal]) {
    requireIt(Object.keys(object(workflow.on)).join(',') === 'workflow_call');
    requireIt(same(workflow.permissions, {}));
  }
  const inputs = object(object(object(orchestrator.on).workflow_call).inputs);
  requireIt(Object.keys(inputs).sort().join(',') === 'fingerprint,issue');
  const top = object(orchestrator.jobs);
  requireIt(Object.keys(top).sort().join(',') === 'propose,sandbox');
  const callSandbox = object(top.sandbox);
  const callProposal = object(top.propose);
  const liveGuard =
    "github.ref == 'refs/heads/main' && github.repository == 'TheBushidoCollective/relik' && vars.ERROR_REPORTS_MODE == 'live' && vars.AUTOFIX_MODE == 'on'";
  for (const job of [callSandbox, callProposal])
    requireIt(job.if === liveGuard && !('environment' in job));
  requireIt(callSandbox.uses === './.github/workflows/autofix-sandbox.yml');
  requireIt(
    callProposal.uses === './.github/workflows/autofix-propose.yml' &&
      callProposal.needs === 'sandbox'
  );
  requireIt(
    same(callSandbox.permissions, { contents: 'read', 'id-token': 'write' })
  );
  requireIt(
    same(callProposal.permissions, {
      contents: 'write',
      'pull-requests': 'write',
    })
  );
  const runnerJobs = object(runner.jobs);
  requireIt(Object.keys(runnerJobs).sort().join(',') === 'sandbox,test');
  const sandbox = object(runnerJobs.sandbox);
  const test = object(runnerJobs.test);
  const runnerGuard =
    "github.ref == 'refs/heads/main' && github.repository == 'TheBushidoCollective/relik' && (inputs.fixture == 'regression' || (inputs.fixture == '' && vars.ERROR_REPORTS_MODE == 'live' && vars.AUTOFIX_MODE == 'on'))";
  for (const job of [sandbox, test])
    requireIt(job.if === runnerGuard && !('environment' in job));
  requireIt(
    same(sandbox.permissions, { contents: 'read', 'id-token': 'write' })
  );
  requireIt(
    same(test.permissions, { contents: 'read' }) && test.needs === 'sandbox'
  );
  guardTrustedCheckout(sandbox);
  guardTrustedCheckout(test);
  const sandboxSteps = steps(sandbox);
  requireIt(
    sandboxSteps.map((step) => step.name ?? step.uses ?? step.id).join('|') ===
      [
        'actions/checkout@v4',
        'jdx/mise-action@v2',
        'Install trusted dependencies and build sandbox',
        'Validate authenticated issue',
        'google-github-actions/auth@v2',
        'Fetch pinned context and credential',
        'Prepare pinned context',
        'Run isolated fixer',
        'Extract and scan untrusted patch',
        'Remove credential material',
        'canary',
        'Upload scanned patch only',
      ].join('|')
  );
  const fixer = stepByName(sandbox, 'Run isolated fixer');
  requireIt(
    !('env' in fixer) &&
      typeof fixer.run === 'string' &&
      fixer.run.includes('run-agent-container.sh')
  );
  const scan = stepByName(sandbox, 'Extract and scan untrusted patch');
  const cleanup = stepByName(sandbox, 'Remove credential material');
  const canaryOutput = sandboxSteps.find((step) => step.id === 'canary');
  requireIt(
    canaryOutput &&
      canaryOutput.if === "success() && inputs.fixture == 'regression'"
  );
  requireIt(
    sandboxSteps.indexOf(scan) < sandboxSteps.indexOf(cleanup) &&
      sandboxSteps.indexOf(cleanup) < sandboxSteps.indexOf(canaryOutput)
  );
  requireIt(
    typeof scan.run === 'string' &&
      scan.run.includes('autofix-scan.ts') &&
      scan.run.includes('autofix-check-canary.ts')
  );
  requireIt(
    scan.run.includes('GIT_TERMINAL_PROMPT=0') &&
      scan.run.includes(
        'GIT_OBJECT_DIRECTORY="$RUNNER_TEMP/autofix-objects"'
      ) &&
      scan.run.includes(
        'GIT_ALTERNATE_OBJECT_DIRECTORIES="$GITHUB_WORKSPACE/.git/objects"'
      ) &&
      scan.run.includes('read-tree "$base" 2>/dev/null') &&
      scan.run.includes('add -A -- . >/dev/null 2>&1') &&
      scan.run.includes(
        "2>/dev/null || { echo 'Autofix patch extraction refused'"
      ) &&
      scan.run.includes(
        'trap \'rm -rf -- "$RUNNER_TEMP/autofix-work" "$RUNNER_TEMP/autofix-objects"'
      )
  );
  requireIt(
    cleanup.if === 'always()' &&
      typeof cleanup.run === 'string' &&
      cleanup.run.includes(
        'rm -rf -- "$RUNNER_TEMP/autofix-work" "$RUNNER_TEMP/autofix-objects"'
      ) &&
      cleanup.run.includes("|| { echo 'Autofix cleanup refused' >&2; exit 1; }")
  );
  const install = stepByName(
    sandbox,
    'Install trusted dependencies and build sandbox'
  );
  requireIt(
    typeof install.run === 'string' &&
      install.run.includes('export GIT_TERMINAL_PROMPT=0') &&
      (install.run.match(/--backend=copyfile/g) ?? []).length === 2 &&
      install.run.includes(
        'GIT_OBJECT_DIRECTORY="$RUNNER_TEMP/autofix-objects"'
      ) &&
      install.run.includes(
        'GIT_ALTERNATE_OBJECT_DIRECTORIES="$GITHUB_WORKSPACE/.git/objects"'
      )
  );
  requireIt(!/\bcd\s+["']?\$RUNNER_TEMP\/autofix-work/.test(scan.run));
  requireIt(
    !/(?:^|[;&|]|\n)\s*(?:bun|node|bash|sh|python3|source|eval)\s+["']?\$RUNNER_TEMP\/autofix-work/.test(
      scan.run
    )
  );
  const upload = stepByName(sandbox, 'Upload scanned patch only');
  requireIt(
    upload.if === "success() && inputs.fixture == ''" &&
      upload.uses === 'actions/upload-artifact@v4'
  );
  exactPath(upload, [
    `\${{ runner.temp }}/autofix-safe/patch.diff`,
    `\${{ runner.temp }}/autofix-safe/metadata.json`,
  ]);
  const testSteps = steps(test);
  requireIt(
    !testSteps.some(
      (step) =>
        typeof step.uses === 'string' && step.uses.startsWith('actions/cache')
    )
  );
  for (const step of testSteps) {
    if (step.with !== undefined) {
      const cache = object(step.with).cache;
      requireIt(cache === undefined || cache === false);
    }
  }
  const setup = testSteps.find((step) => step.uses === 'jdx/mise-action@v2');
  requireIt(setup && object(setup.with).cache === false);
  requireIt(
    testSteps.map((step) => step.name ?? step.uses).join('|') ===
      [
        'actions/checkout@v4',
        'jdx/mise-action@v2',
        'Install trusted dependencies and build sandbox',
        'actions/download-artifact@v4',
        'Restore scanned canary patch',
        'Verify patch and run targeted replay',
        'Upload fixed test result only',
      ].join('|')
  );
  const restore = stepByName(test, 'Restore scanned canary patch');
  requireIt(restore.if === "inputs.fixture == 'regression'");
  requireIt(
    same(restore.env, {
      PATCH: `\${{ needs.sandbox.outputs.patch }}`,
      METADATA: `\${{ needs.sandbox.outputs.metadata }}`,
    })
  );
  requireIt(typeof restore.run === 'string');
  requireIt(
    restore.run
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .join('\n') ===
      [
        'set -euo pipefail',
        'mkdir -m 700 "$RUNNER_TEMP/autofix-safe"',
        'printf \'%s\' "$PATCH" | base64 -d > "$RUNNER_TEMP/autofix-safe/patch.diff"',
        'printf \'%s\' "$METADATA" | base64 -d > "$RUNNER_TEMP/autofix-safe/metadata.json"',
      ].join('\n')
  );
  const replay = stepByName(test, 'Verify patch and run targeted replay');
  requireIt(same(replay.env, { FIXTURE: `\${{ inputs.fixture }}` }));
  requireIt(typeof replay.run === 'string');
  requireIt(
    replay.run
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .join('\n') ===
      [
        'set -euo pipefail',
        'bun packages/relic-ops/bin/autofix-check-patch.ts verify "$RUNNER_TEMP/autofix-safe/patch.diff" "$RUNNER_TEMP/autofix-safe/metadata.json"',
        'mkdir -m 700 "$RUNNER_TEMP/autofix-result"',
        'if [[ "$FIXTURE" == regression ]]; then',
        'bun packages/relic-ops/bin/autofix-repro.ts "$RUNNER_TEMP/autofix-safe/patch.diff" "$RUNNER_TEMP/autofix-result/result.json" --fixture',
        'else',
        'bun packages/relic-ops/bin/autofix-repro.ts "$RUNNER_TEMP/autofix-safe/patch.diff" "$RUNNER_TEMP/autofix-result/result.json"',
        'fi',
      ].join('\n')
  );
  const resultUpload = stepByName(test, 'Upload fixed test result only');
  requireIt(testSteps.indexOf(replay) < testSteps.indexOf(resultUpload));
  exactPath(resultUpload, [`\${{ runner.temp }}/autofix-result/result.json`]);
  const proposalJobs = object(proposal.jobs);
  requireIt(Object.keys(proposalJobs).join(',') === 'propose');
  const proposer = object(proposalJobs.propose);
  requireIt(proposer.if === liveGuard && !('environment' in proposer));
  requireIt(
    same(proposer.permissions, { contents: 'write', 'pull-requests': 'write' })
  );
  guardTrustedCheckout(proposer);
  for (const step of steps(proposer)) {
    if (typeof step.uses === 'string')
      requireIt(
        !/google-github-actions\/auth|actions\/cache|mise-action/.test(
          step.uses
        )
      );
    if (typeof step.run !== 'string') continue;
    requireIt(!/\bcd\s/.test(step.run));
    requireIt(
      !/\b(?:bun|npm|npx|yarn|pnpm|make|bash|sh|source|eval|docker)\b/.test(
        step.run
      )
    );
    requireIt(
      !/\bnode\s+(?!packages\/relic-ops\/bin\/autofix-(?:check-patch|pr-body)\.ts\b)/.test(
        step.run
      )
    );
    requireIt(!/\bpython3\s+(?!-\s+"\$auth_config")/.test(step.run));
    requireIt(
      !/OMP_VAULT|ACTIONS_ID_TOKEN|google-github-actions\/auth/.test(step.run)
    );
  }
  requireIt(same(caller.permissions, {}));
  requireIt(
    Object.keys(object(caller.on)).sort().join(',') ===
      'schedule,workflow_dispatch'
  );
  const file = object(object(caller.jobs).file);
  requireIt(
    file.if === "github.ref == 'refs/heads/main'" && !('environment' in file)
  );
  requireIt(
    same(file.permissions, {
      contents: 'read',
      issues: 'write',
      'pull-requests': 'read',
      'id-token': 'write',
    })
  );
  guardTrustedCheckout(file);
  const filingEnv = object(stepByName(file, 'Validate and file reports').env);
  requireIt(
    filingEnv.AUTOFIX_MODE ===
      `\${{ vars.ERROR_REPORTS_MODE == 'live' && (inputs.mode || vars.ERROR_REPORTS_MODE || 'dry-run') == 'live' && (vars.AUTOFIX_MODE || 'off') || 'off' }}`
  );
  const call = object(object(caller.jobs).autofix);
  requireIt(
    typeof call.if === 'string' &&
      call.if.includes("github.ref == 'refs/heads/main'") &&
      call.if.includes("vars.ERROR_REPORTS_MODE == 'live'") &&
      call.if.includes("vars.AUTOFIX_MODE == 'on'")
  );
  requireIt(call.uses === './.github/workflows/autofix.yml');
  requireIt(
    object(object(call.strategy).matrix).candidate ===
      `\${{ fromJSON(needs.file.outputs.autofix) }}`
  );
  requireIt(
    Object.keys(object(canary.on)).join(',') === 'workflow_dispatch' &&
      same(canary.permissions, {})
  );
  const canaryJobs = object(canary.jobs);
  requireIt(Object.keys(canaryJobs).join(',') === 'canary');
  const canaryJob = object(canaryJobs.canary);
  requireIt(
    !('environment' in canaryJob) &&
      canaryJob.if ===
        "github.ref == 'refs/heads/main' && github.repository == 'TheBushidoCollective/relik'"
  );
  requireIt(
    same(canaryJob.permissions, { contents: 'read', 'id-token': 'write' })
  );
  requireIt(canaryJob.uses === './.github/workflows/autofix-sandbox.yml');
  requireIt(
    same(canaryJob.with, {
      issue: 0,
      fingerprint: '0000000000000000',
      fixture: 'regression',
    })
  );
}

/** The host may apply patch data, but only the networkless container runs tests. */
export function guardReplaySource(source: string): void {
  requireIt((source.match(/\bspawnSync\s*\(/g) ?? []).length === 1);
  requireIt(/spawnSync\(\s*'docker'/.test(source));
  requireIt((source.match(/\bexecFileSync\s*\(/g) ?? []).length === 4);
  requireIt((source.match(/execFileSync\(\s*'git'/g) ?? []).length === 4);
  for (const pattern of [
    /'--network',\s*'none'/,
    /'--read-only'/,
    /'--cap-drop',\s*'ALL'/,
    /'no-new-privileges'/,
    /'--user'/,
    /! -S \/var\/run\/docker\.sock/,
    /! command -v sudo/,
    /ACTIONS_\|GITHUB_TOKEN\$\|GH_TOKEN\$/,
    /exec timeout --kill-after=5s 300s bun test/,
  ])
    requireIt(pattern.test(source));
  for (const required of [
    "'ls-files'",
    'originalPackages.every(',
    'sourceIncludes',
    '.filter(isOriginalTestPath)',
    'passesOriginalTests(originalResult)',
    'constants.O_NOFOLLOW',
    'constants.O_NONBLOCK',
    'stat.isFile()',
  ])
    requireIt(source.includes(required));
  requireIt((source.match(/'--env'/g) ?? []).length === 2);
  requireIt(
    source.includes("'HOME=/home/agent'") && source.includes("'LANG=C.UTF-8'")
  );
  requireIt(
    !/'--privileged'|'--network=host'|dst=\/var\/run\/docker\.sock/.test(source)
  );
}

/** The credentialed fixer may execute only under the isolated launcher. */
export function guardLauncherSource(source: string): void {
  for (const required of [
    'docker network create --internal "$network"',
    'sudo iptables -I INPUT 1 -s "$subnet" -j "$chain"',
    'timeout --kill-after=5s 45m docker run',
    '--network "$network"',
    '--log-driver=none',
    '--read-only --cap-drop ALL',
    '--security-opt no-new-privileges',
    '--pids-limit 256',
    '--ulimit fsize=1048576:1048576',
    'src=$agent,dst=$agent,readonly',
    '! -S /var/run/docker.sock',
    '! command -v sudo',
    '[[ $$ == 1',
    '/tmp/agent-output 2>&1',
    'rm -f /tmp/agent-output',
    "' >/dev/null 2>&1",
  ])
    requireIt(source.includes(required));
  requireIt(
    !/--env\s+["']?(?:ACTIONS_|GITHUB_TOKEN|GH_TOKEN|OMP_VAULT_)/.test(source)
  );
  requireIt(
    !/--privileged|--network[= ]host|src=\/var\/run\/docker\.sock/.test(source)
  );
}

/** PR code may not inherit a write or OIDC token from repository defaults. */
export function guardPullRequestWorkflow(yaml: string): void {
  const workflow = object(Bun.YAML.parse(yaml));
  const triggers = object(workflow.on);
  requireIt(!('pull_request_target' in triggers));
  const permissions = object(workflow.permissions);
  if (!('pull_request' in triggers)) return;
  requireIt(permissions.contents === 'read');
  for (const [name, value] of Object.entries(permissions))
    requireIt(
      (value === 'read' || value === 'none') &&
        !(name === 'id-token' && value !== 'none')
    );
  for (const value of Object.values(object(workflow.jobs))) {
    const job = object(value);
    if (job.permissions !== undefined)
      for (const [name, access] of Object.entries(object(job.permissions)))
        requireIt(
          (access === 'read' || access === 'none') &&
            !(name === 'id-token' && access !== 'none')
        );
    if (job.steps === undefined) continue;
    for (const step of steps(job))
      if (
        typeof step.uses === 'string' &&
        step.uses.startsWith('actions/checkout@')
      )
        requireIt(object(step.with)['persist-credentials'] === false);
  }
}
