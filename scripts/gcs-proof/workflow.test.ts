import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  'continue-on-error'?: boolean;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};

type Job = {
  if?: string;
  needs?: string | string[];
  'timeout-minutes'?: number;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  steps: Step[];
};

type Workflow = {
  name?: string;
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  concurrency?: Record<string, unknown>;
  jobs: Record<string, Job>;
};

function loadWorkflow(path: string): Workflow {
  return Bun.YAML.parse(
    readFileSync(new URL(path, import.meta.url), 'utf8')
  ) as Workflow;
}

const proof = loadWorkflow('../../.github/workflows/gcs-proof.yml');
const janitor = loadWorkflow('../../.github/workflows/gcs-proof-janitor.yml');
const verify = loadWorkflow('../../.github/workflows/verify.yml');

function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function sameObject(
  actual: Record<string, unknown> | undefined,
  expected: Record<string, unknown>
): boolean {
  if (!actual) return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return (
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys) &&
    expectedKeys.every((key) => actual[key] === expected[key])
  );
}

function step(job: Job, name: string): Step {
  const matches = job.steps.filter((item) => item.name === name);
  requireThat(matches.length === 1, `expected one step named ${name}`);
  return matches[0]!;
}

function before(job: Job, first: string, second: string): void {
  const a = step(job, first);
  const b = step(job, second);
  requireThat(
    job.steps.indexOf(a) < job.steps.indexOf(b),
    `${first} must precede ${second}`
  );
}

function includesAll(text: string | undefined, values: string[]): boolean {
  return (
    typeof text === 'string' && values.every((value) => text.includes(value))
  );
}

function directWif(item: Step): boolean {
  return (
    item.uses === 'google-github-actions/auth@v2' &&
    !!item.with &&
    !('service_account' in item.with) &&
    item.with.create_credentials_file === false &&
    item.with.export_environment_variables === false
  );
}

function artifact(
  job: Job,
  name: string,
  expectedName: string,
  path: string
): void {
  const item = step(job, name);
  requireThat(
    item.uses === 'actions/upload-artifact@v4',
    `${name}: wrong uploader`
  );
  requireThat(item.with?.name === expectedName, `${name}: wrong artifact name`);
  requireThat(item.with?.path === path, `${name}: wrong artifact contents`);
  requireThat(item.with?.['retention-days'] === 1, `${name}: wrong retention`);
  requireThat(
    item.with?.['if-no-files-found'] === 'error',
    `${name}: missing artifact must fail`
  );
  requireThat(item.with?.overwrite !== true, `${name}: mutable artifact`);
}

function checkProof(workflow: Workflow): void {
  requireThat(workflow.name === 'GCS digest proof', 'wrong proof workflow');
  requireThat(
    sameObject(workflow.permissions, {}),
    'top-level permissions must be empty'
  );
  requireThat(
    JSON.stringify(Object.keys(workflow.on).sort()) ===
      JSON.stringify(['workflow_dispatch']),
    'proof must be dispatch-only'
  );
  requireThat(
    workflow.concurrency?.['cancel-in-progress'] === false,
    'proof cancels active run'
  );
  requireThat(
    JSON.stringify(Object.keys(workflow.jobs).sort()) ===
      JSON.stringify([
        'cleanup_safety',
        'exercise',
        'mint',
        'provision',
        'teardown',
      ]),
    'unexpected proof job'
  );
  const {
    cleanup_safety: safety,
    provision,
    mint,
    exercise,
    teardown,
  } = workflow.jobs;
  requireThat(
    !!safety && !!provision && !!mint && !!exercise && !!teardown,
    'missing proof job'
  );
  requireThat(
    safety.if === "github.ref == 'refs/heads/main'" &&
      sameObject(safety.permissions, {}) &&
      !safety.needs &&
      safety.steps.length === 1,
    'cleanup safety guard must run without credentials'
  );
  const safetyStep = step(safety, 'Require verified safe bucket cleanup');
  requireThat(
    !safetyStep.uses &&
      !safetyStep.if &&
      safetyStep['continue-on-error'] !== true &&
      safetyStep.run?.trim() ===
        "echo 'GCS_PROOF_BLOCKED safe bucket cleanup unavailable; this run created no proof resources' >&2\nexit 1",
    'proof must fail closed until a safe cleanup capability is reviewed'
  );
  requireThat(
    provision.needs === 'cleanup_safety',
    'provision must follow cleanup safety'
  );
  requireThat(
    provision.if === "github.ref == 'refs/heads/main'",
    'provision is not main-only'
  );
  requireThat(
    teardown.if ===
      "always() && github.ref == 'refs/heads/main' && needs.cleanup_safety.result == 'success'",
    'teardown must run only after cleanup safety passes'
  );
  requireThat(mint.needs === 'provision', 'mint must run after provision');
  requireThat(
    exercise.needs === 'provision',
    'exercise must run alongside mint'
  );
  requireThat(
    !mint.if && !exercise.if,
    'mint and exercise must not bypass the provision dependency'
  );
  requireThat(
    JSON.stringify(teardown.needs) ===
      JSON.stringify(['cleanup_safety', 'provision', 'mint', 'exercise']),
    'teardown must depend on all proof jobs'
  );
  requireThat(
    sameObject(provision.permissions, {
      contents: 'read',
      'pull-requests': 'read',
      'id-token': 'write',
    }),
    'wrong provision permissions'
  );
  requireThat(
    sameObject(mint.permissions, {
      contents: 'read',
      actions: 'read',
      'id-token': 'write',
    }),
    'wrong mint permissions'
  );
  requireThat(
    sameObject(exercise.permissions, { contents: 'read', actions: 'read' }),
    'exercise must not receive id-token or write permissions'
  );
  requireThat(
    sameObject(teardown.permissions, { contents: 'read', 'id-token': 'write' }),
    'wrong teardown permissions'
  );
  requireThat(provision['timeout-minutes'] === 30, 'wrong provision timeout');
  requireThat(mint['timeout-minutes'] === 30, 'wrong mint timeout');
  requireThat(exercise['timeout-minutes'] === 55, 'wrong exercise timeout');
  requireThat(teardown['timeout-minutes'] === 25, 'wrong teardown timeout');

  let candidateCheckouts = 0;
  const allowedActions: Record<string, string[]> = {
    provision: [
      'actions/checkout@v4',
      'google-github-actions/auth@v2',
      'google-github-actions/setup-gcloud@v2',
    ],
    mint: [
      'actions/checkout@v4',
      'google-github-actions/auth@v2',
      'actions/upload-artifact@v4',
    ],
    exercise: [
      'actions/checkout@v4',
      'actions/checkout@v4',
      'actions/upload-artifact@v4',
      'actions/upload-artifact@v4',
    ],
    teardown: [
      'actions/checkout@v4',
      'google-github-actions/auth@v2',
      'google-github-actions/setup-gcloud@v2',
      'google-github-actions/auth@v2',
    ],
  };
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === 'cleanup_safety') continue;
    const actions = job.steps.flatMap((item) => (item.uses ? [item.uses] : []));
    requireThat(
      JSON.stringify(actions) === JSON.stringify(allowedActions[name]),
      `${name}: unexpected action or action order`
    );
    let trustedCheckouts = 0;
    for (const item of job.steps) {
      requireThat(
        !item.run?.includes('${{'),
        `${name}: shell expression interpolation`
      );
      if (item.uses === 'actions/checkout@v4') {
        requireThat(
          item.with?.['persist-credentials'] === false,
          `${name}: checkout persists credentials`
        );
        if (item.with.ref === '${{ needs.provision.outputs.sha }}') {
          requireThat(
            name === 'exercise' && item.with.path === 'candidate',
            'candidate checkout in privileged job'
          );
          candidateCheckouts++;
        } else {
          requireThat(
            item.with.ref === '${{ github.sha }}',
            `${name}: untrusted checkout`
          );
          requireThat(
            item.with.path === 'trusted',
            `${name}: trusted checkout path differs`
          );
          trustedCheckouts++;
        }
      }
      if (name !== 'exercise') {
        requireThat(
          !item.run?.includes('docker run'),
          `${name}: candidate execution in privileged job`
        );
        requireThat(
          !item.run?.includes('git -C candidate'),
          `${name}: candidate code in privileged job`
        );
      }
    }
    requireThat(trustedCheckouts === 1, `${name}: trusted checkout missing`);
  }
  requireThat(
    candidateCheckouts === 1,
    'candidate must be checked out exactly once'
  );
  requireThat(
    exercise.steps[0]?.name === 'Require no OIDC credentials' &&
      includesAll(exercise.steps[0]?.run, [
        '[[ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" && -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]]',
        'exit 1',
        'GCS_PROOF_EXERCISE_NO_OIDC',
      ]),
    'exercise OIDC guard must be first'
  );
  requireThat(
    exercise.steps.every(
      (item) =>
        !item.uses ||
        ['actions/checkout@v4', 'actions/upload-artifact@v4'].includes(
          item.uses
        )
    ),
    'exercise has an unexpected action'
  );
  requireThat(
    !JSON.stringify(exercise).includes('vars.DEPLOYER_SA') &&
      !JSON.stringify(exercise).includes('vars.WIF_PROVIDER') &&
      !JSON.stringify(exercise).includes('steps.wif.outputs'),
    'exercise references deployer or federated credentials'
  );

  const create = step(provision, 'Create and verify leased proof resources');
  requireThat(
    includesAll(create.run, [
      'resources.py provision',
      'resources.py check-provisioned',
      'trap publish_identity EXIT',
      'provisioned=%s',
    ]),
    'resources not provisioned and checked'
  );
  const fixtures = step(provision, 'Create and independently measure fixtures');
  requireThat(
    includesAll(fixtures.run, [
      '--account-uid "$ACCOUNT_UID"',
      '--expires "$EXPIRES"',
    ]) &&
      fixtures.env?.ACCOUNT_UID ===
        '${{ steps.resources.outputs.account_uid }}',
    'fixtures must verify the provisioned account UID and lease'
  );
  const provisionOutputs = provision.outputs ?? {};
  requireThat(
    provisionOutputs.account_uid ===
      '${{ steps.resources.outputs.account_uid }}',
    'missing provisioned account UID output'
  );
  for (const output of [
    'provisioned',
    'bucket',
    'account',
    'account_uid',
    'expires',
  ]) {
    requireThat(
      !!provisionOutputs[output],
      `missing provision output ${output}`
    );
  }
  for (const job of [provision, teardown]) {
    const deployer = step(job, 'Authenticate as deployer');
    requireThat(
      deployer.uses === 'google-github-actions/auth@v2' &&
        deployer.with?.service_account === '${{ vars.DEPLOYER_SA }}',
      'trusted resource management must use the deployer'
    );
  }
  const wif = step(mint, 'Obtain a federated identity');
  requireThat(
    directWif(wif) && wif.id === 'wif',
    'mint must use direct WIF without exported credentials'
  );
  const mintToken = step(mint, 'Mint the leased account token');
  requireThat(
    includesAll(mintToken.run, [
      'resources.py mint',
      '--lifetime-seconds 2700',
      '--deadline-seconds 420',
      '--token-file',
      '--meta-file',
    ]) &&
      mintToken.env?.GCS_PROOF_FEDERATED_TOKEN ===
        '${{ steps.wif.outputs.auth_token }}',
    'mint does not use a bounded token from direct WIF'
  );
  const scope = step(mint, "Verify the token's complete scope");
  requireThat(
    scope.id === 'scope' &&
      includesAll(scope.run, [
        'resources.py check-scope',
        '--token-file',
        'ok=true',
      ]),
    'scope check missing'
  );
  requireThat(
    mint.outputs?.scope_ok === '${{ steps.scope.outputs.ok }}',
    'scope result missing'
  );
  before(mint, 'Await the exercise public key', 'Obtain a federated identity');
  before(
    mint,
    'Mint the leased account token',
    "Verify the token's complete scope"
  );
  before(
    mint,
    "Verify the token's complete scope",
    'Seal the token for this attempt'
  );
  before(mint, 'Seal the token for this attempt', 'Upload the sealed token');
  requireThat(
    includesAll(step(mint, 'Seal the token for this attempt').run, [
      'handoff.js seal',
      '--key-json',
      '--token-file',
      '--expire-time',
      '--context',
      'trap',
      'rm -f',
    ]),
    'sealed token handoff missing or plaintext not removed'
  );
  requireThat(
    includesAll(step(mint, 'Await the exercise public key').run, [
      'await-artifact.sh',
      'handoff-key.json',
      '720 1024',
    ]),
    'public-key artifact is not bounded'
  );
  artifact(
    mint,
    'Upload the sealed token',
    'gcs-proof-handoff-token-${{ github.run_id }}-${{ github.run_attempt }}',
    '${{ runner.temp }}/handoff/sealed.json'
  );

  for (const job of [mint, exercise]) {
    requireThat(
      includesAll(step(job, "Validate this attempt's resource identity").run, [
        'resources.py check-provisioned',
        '--run "$GITHUB_RUN_ID"',
        '--attempt "$GITHUB_RUN_ATTEMPT"',
        '--provisioned-json',
      ]),
      'resource identities must match the current attempt'
    );
  }
  before(
    exercise,
    'Prepare only the candidate GCS module and runtime image',
    'Create the handoff key'
  );
  before(exercise, 'Create the handoff key', 'Upload the handoff public key');
  before(
    exercise,
    'Upload the handoff public key',
    'Await and open the sealed token'
  );
  before(
    exercise,
    'Await and open the sealed token',
    'Run candidate in isolated Bun container'
  );
  artifact(
    exercise,
    'Upload the handoff public key',
    'gcs-proof-handoff-key-${{ github.run_id }}-${{ github.run_attempt }}',
    '${{ runner.temp }}/handoff/handoff-key.json'
  );
  requireThat(
    includesAll(step(exercise, 'Await and open the sealed token').run, [
      'await-artifact.sh',
      'sealed.json',
      '1200 16384',
      'handoff.js open',
      '--context',
      'rm -f "$RUNNER_TEMP/handoff/handoff-key.pem"',
      '::add-mask::',
      'now + 1620',
      'now < 1440',
    ]),
    'exercise must decrypt, mask and check the remaining lease'
  );
  const container = step(exercise, 'Run candidate in isolated Bun container');
  requireThat(
    includesAll(container.run, [
      'RUNNER_TEMP/handoff/token',
      'docker run --rm',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--pull never',
      '-e GCS_PROOF_PROJECT',
    ]) &&
      container.env?.GCS_PROOF_CLIENT_EMAIL ===
        '${{ needs.provision.outputs.account }}',
    'candidate container or per-run credentials are not isolated'
  );
  requireThat(
    includesAll(step(exercise, 'Validate and publish bounded result').run, [
      'verify.py validate',
      '--token-file',
      'rm -f',
    ]),
    'result must be scanned for the token and plaintext deleted'
  );
  requireThat(
    step(exercise, 'Remove handoff secrets after failure').if === 'always()',
    'failure secret cleanup missing'
  );

  requireThat(
    step(teardown, 'Verify results independently').env?.SCOPE_OK ===
      '${{ needs.mint.outputs.scope_ok }}',
    'teardown must use the mint scope result'
  );
  requireThat(
    directWif(
      step(teardown, 'Obtain a fresh federated identity for revocation')
    ),
    'revocation must use direct WIF'
  );
  const revoke = step(teardown, 'Revoke and verify the leased account');
  requireThat(
    revoke.env?.GCS_PROOF_FEDERATED_TOKEN ===
      '${{ steps.wif.outputs.auth_token }}' &&
      includesAll(revoke.run, ['resources.py revoke', '--provisioned-json']) &&
      includesAll(revoke.if, [
        'always()',
        "needs.provision.result == 'success'",
      ]),
    'revocation must run after provisioning with direct WIF'
  );
  const cleanup = step(
    teardown,
    'Delete and confirm absence of proof resources'
  );
  requireThat(
    cleanup.if === 'always()' &&
      cleanup['continue-on-error'] !== true &&
      !cleanup.run?.includes('|| true') &&
      includesAll(cleanup.run, [
        'resources.py teardown',
        '--run',
        '--attempt',
        '--repo-id',
        '--provisioned-json "$PROVISIONED"',
      ]),
    'cleanup must always target this attempt'
  );
  before(
    teardown,
    'Verify results independently',
    'Revoke and verify the leased account'
  );
  before(
    teardown,
    'Revoke and verify the leased account',
    'Delete and confirm absence of proof resources'
  );
  before(
    teardown,
    'Delete and confirm absence of proof resources',
    'Require complete verification and cleanup'
  );
  const gate = step(teardown, 'Require complete verification and cleanup');
  requireThat(
    gate.if === 'always()' &&
      includesAll(gate.run, [
        'PROVISION_RESULT',
        'MINT_RESULT',
        'EXERCISE_RESULT',
        'VERIFY_RESULT',
        'REVOKE_RESULT',
        'CLEANUP_RESULT',
        'GCS_PROOF_VERIFIED',
        'account_uid',
      ]),
    'success gate must require every proof and cleanup outcome'
  );
  for (const [key, expected] of Object.entries({
    PROVISION_RESULT: '${{ needs.provision.result }}',
    MINT_RESULT: '${{ needs.mint.result }}',
    EXERCISE_RESULT: '${{ needs.exercise.result }}',
    VERIFY_RESULT: '${{ steps.verify.outcome }}',
    REVOKE_RESULT: '${{ steps.revoke.outcome }}',
    CLEANUP_RESULT: '${{ steps.cleanup.outcome }}',
  })) {
    requireThat(gate.env?.[key] === expected, `incorrect gate input ${key}`);
    requireThat(
      gate.run?.includes(`"$${key}" != success`),
      `gate must require ${key} to succeed`
    );
  }
}

function checkJanitor(workflow: Workflow): void {
  requireThat(
    sameObject(workflow.permissions, {}),
    'janitor top-level permissions must be empty'
  );
  requireThat(
    JSON.stringify(Object.keys(workflow.on).sort()) ===
      JSON.stringify(['schedule', 'workflow_dispatch', 'workflow_run']),
    'wrong janitor triggers'
  );
  const schedule = workflow.on.schedule as Array<{ cron: string }>;
  requireThat(
    schedule.length === 1 && schedule[0]?.cron === '0 * * * *',
    'janitor must run hourly'
  );
  const run = workflow.on.workflow_run as {
    workflows: string[];
    types: string[];
  };
  requireThat(
    JSON.stringify(run.workflows) === JSON.stringify(['GCS digest proof']) &&
      JSON.stringify(run.types) === JSON.stringify(['completed']),
    'janitor must follow completed proof workflows only'
  );
  const dispatch = workflow.on.workflow_dispatch as {
    inputs: Record<string, { default: unknown }>;
  };
  requireThat(
    dispatch.inputs.dry_run?.default === true,
    'manual janitor must default to dry run'
  );
  requireThat(
    dispatch.inputs.min_age_minutes?.default === '15',
    'wrong manual minimum age'
  );
  requireThat(
    workflow.concurrency?.['cancel-in-progress'] === false,
    'janitor cancels active sweep'
  );
  requireThat(
    Object.keys(workflow.jobs).length === 1,
    'unexpected janitor job'
  );
  const cleanup = workflow.jobs.cleanup;
  requireThat(!!cleanup, 'missing janitor cleanup job');
  requireThat(
    includesAll(cleanup.if, [
      "github.ref == 'refs/heads/main'",
      "github.event_name != 'workflow_run'",
      "github.event.workflow_run.event == 'workflow_dispatch'",
      "github.event.workflow_run.head_branch == 'main'",
      'github.event.workflow_run.head_repository.id == github.repository_id',
    ]),
    'janitor workflow-run provenance guard missing'
  );
  requireThat(
    sameObject(cleanup.permissions, {
      contents: 'read',
      actions: 'read',
      'id-token': 'write',
    }),
    'wrong janitor permissions'
  );
  requireThat(cleanup['timeout-minutes'] === 30, 'wrong janitor timeout');
  const actions = cleanup.steps.flatMap((item) =>
    item.uses ? [item.uses] : []
  );
  requireThat(
    JSON.stringify(actions) ===
      JSON.stringify([
        'actions/checkout@v4',
        'google-github-actions/auth@v2',
        'google-github-actions/setup-gcloud@v2',
      ]),
    'janitor contains an unexpected action'
  );
  for (const item of cleanup.steps) {
    requireThat(
      !item.run?.includes('${{'),
      'janitor interpolates expressions in shell'
    );
    requireThat(
      !item.uses?.includes('download-artifact'),
      'janitor must not download artifacts'
    );
    requireThat(
      !item.run?.includes('gh run download') &&
        !item.run?.includes('await-artifact.sh'),
      'janitor must not fetch artifacts'
    );
    if (item.uses === 'actions/checkout@v4') {
      requireThat(
        item.with?.ref === '${{ github.sha }}' &&
          item.with?.['persist-credentials'] === false,
        'janitor checkout is untrusted'
      );
    }
  }
  const sweep = step(cleanup, 'Sweep eligible completed proof attempts');
  requireThat(
    sweep['continue-on-error'] !== true &&
      !sweep.run?.includes('|| true') &&
      includesAll(sweep.run, [
        'set -euo pipefail',
        'schedule) dry_run=false; age=15',
        'workflow_run) dry_run=false; age=0',
        'workflow_dispatch) dry_run="$DRY_RUN"; age="$MIN_AGE_MINUTES"',
        'resources.py janitor',
        '--repo-id',
        '--dry-run',
        '--min-age-minutes',
      ]),
    'janitor must run a full validated sweep with trigger-specific options'
  );
}

test('proof and janitor workflows enforce the per-run identity boundary', () => {
  checkProof(proof);
  checkJanitor(janitor);
  const linux = verify.jobs.verify;
  requireThat(!!linux, 'verify job missing');
  expect(step(linux, 'Test GCS proof resource guards').run).toBe(
    "python3 -m unittest discover -s scripts/gcs-proof -p 'test_*.py'"
  );
});

test('proof workflow guard rejects boundary regressions', () => {
  const mutations: Array<(copy: Workflow) => void> = [
    (copy) => {
      step(
        copy.jobs.cleanup_safety!,
        'Require verified safe bucket cleanup'
      ).run = 'exit 0';
    },
    (copy) => {
      copy.jobs.cleanup_safety!.permissions!['id-token'] = 'write';
    },
    (copy) => {
      copy.jobs.provision!.needs = undefined;
    },
    (copy) => {
      copy.jobs.teardown!.if = "always() && github.ref == 'refs/heads/main'";
    },
    (copy) => {
      copy.jobs.exercise!.permissions!['id-token'] = 'write';
    },
    (copy) => {
      copy.jobs.exercise!.needs = ['provision', 'mint'];
    },
    (copy) => {
      copy.jobs.exercise!.steps.shift();
    },
    (copy) => {
      step(copy.jobs.exercise!, 'Require no OIDC credentials').run =
        'echo ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN GCS_PROOF_EXERCISE_NO_OIDC';
    },
    (copy) => {
      copy.jobs.mint!.if = 'always()';
    },
    (copy) => {
      copy.jobs.provision!.steps.push({ uses: 'attacker/action@v1' });
    },
    (copy) => {
      const create = step(
        copy.jobs.provision!,
        'Create and verify leased proof resources'
      );
      create.run = create.run!.replace('trap publish_identity EXIT', '');
    },
    (copy) => {
      step(copy.jobs.provision!, 'Create and independently measure fixtures')
        .env!.ACCOUNT_UID = '123';
    },
    (copy) => {
      const fixtures = step(
        copy.jobs.provision!,
        'Create and independently measure fixtures'
      );
      fixtures.run = fixtures.run!.replace('--account-uid "$ACCOUNT_UID"', '');
    },
    (copy) => {
      step(copy.jobs.mint!, 'Check out trusted proof code').with!.ref =
        '${{ needs.provision.outputs.sha }}';
    },
    (copy) => {
      step(copy.jobs.mint!, 'Check out trusted proof code').with![
        'persist-credentials'
      ] = true;
    },
    (copy) => {
      step(copy.jobs.mint!, 'Mint the leased account token').run +=
        '\necho ${{ inputs.candidate_sha }}';
    },
    (copy) => {
      step(copy.jobs.mint!, 'Obtain a federated identity')
        .with!.service_account = '${{ vars.DEPLOYER_SA }}';
    },
    (copy) => {
      step(copy.jobs.exercise!, 'Upload the handoff public key').with!.path =
        '${{ runner.temp }}/handoff/handoff-key.pem';
    },
    (copy) => {
      step(copy.jobs.exercise!, 'Await and open the sealed token').run =
        'node handoff.js open';
    },
    (copy) => {
      step(copy.jobs.teardown!, 'Revoke and verify the leased account')
        .env!.GCS_PROOF_FEDERATED_TOKEN =
        '${{ steps.auth.outputs.auth_token }}';
    },
    (copy) => {
      step(
        copy.jobs.teardown!,
        'Delete and confirm absence of proof resources'
      ).if = 'success()';
    },
    (copy) => {
      step(
        copy.jobs.teardown!,
        'Delete and confirm absence of proof resources'
      )['continue-on-error'] = true;
    },
    (copy) => {
      step(
        copy.jobs.teardown!,
        'Require complete verification and cleanup'
      ).run = 'echo success';
    },
    (copy) => {
      step(copy.jobs.teardown!, 'Require complete verification and cleanup')
        .env!.REVOKE_RESULT = '${{ needs.provision.result }}';
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(proof);
    mutate(copy);
    expect(() => checkProof(copy)).toThrow();
  }
});

test('janitor guard rejects untrusted events and artifact downloads', () => {
  const mutations: Array<(copy: Workflow) => void> = [
    (copy) => {
      copy.jobs.cleanup!.if = "github.ref == 'refs/heads/main'";
    },
    (copy) => {
      step(copy.jobs.cleanup!, 'Check out trusted janitor code').with!.ref =
        '${{ github.event.workflow_run.head_sha }}';
    },
    (copy) => {
      copy.jobs.cleanup!.steps.push({ uses: 'actions/download-artifact@v4' });
    },
    (copy) => {
      step(copy.jobs.cleanup!, 'Sweep eligible completed proof attempts').run =
        'echo ${{ inputs.min_age_minutes }}';
    },
    (copy) => {
      step(copy.jobs.cleanup!, 'Sweep eligible completed proof attempts')[
        'continue-on-error'
      ] = true;
    },
    (copy) => {
      const dispatch = copy.on.workflow_dispatch as {
        inputs: Record<string, { default: unknown }>;
      };
      dispatch.inputs.dry_run!.default = false;
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(janitor);
    mutate(copy);
    expect(() => checkJanitor(copy)).toThrow();
  }
});
