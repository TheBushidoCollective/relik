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
  const sandboxSteps = steps(sandbox);
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
  const verify = stepByName(test, 'Verify exact patch and run full verify');
  requireIt(typeof verify.run === 'string');
  for (const variable of [
    'ACTIONS_RUNTIME_TOKEN',
    'ACTIONS_CACHE_URL',
    'ACTIONS_RESULTS_URL',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ])
    requireIt(verify.run.includes(`-u ${variable}`));
  requireIt(
    verify.run.includes('env -i ') &&
      verify.run.includes('mise exec node@24.15.0 -- mise run verify')
  );
  const result = stepByName(
    test,
    'Record fixed regression result without network'
  );
  const resultUpload = stepByName(test, 'Upload fixed test result only');
  requireIt(
    testSteps.indexOf(verify) < testSteps.indexOf(result) &&
      testSteps.indexOf(result) < testSteps.indexOf(resultUpload)
  );
  exactPath(resultUpload, [`\${{ runner.temp }}/autofix-result/result.json`]);
  const proposalJobs = object(proposal.jobs);
  requireIt(Object.keys(proposalJobs).join(',') === 'propose');
  const proposer = object(proposalJobs.propose);
  requireIt(proposer.if === liveGuard && !('environment' in proposer));
  requireIt(
    same(proposer.permissions, { contents: 'write', 'pull-requests': 'write' })
  );
  for (const step of steps(proposer)) {
    if (typeof step.uses === 'string')
      requireIt(
        !/google-github-actions\/auth|actions\/cache|mise-action/.test(
          step.uses
        )
      );
    if (typeof step.run !== 'string') continue;
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
