import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = new URL('../../../', import.meta.url).pathname;
const scanner = join(root, 'packages/relic-ops/bin/autofix-scan.ts');
const prBody = join(root, 'packages/relic-ops/bin/autofix-pr-body.ts');
const bootstrap = join(root, '.github/scripts/checkout-omp-context.sh');
const sandbox = join(root, '.github/scripts/run-agent-container.sh');
const secret = 'fake-credential-f77f31a2e6';
const source = 'packages/relic-viewer/src/example.ts';
const testPath = 'packages/relic-viewer/test/example.test.ts';
let temp: string;
let workspace: string;
let runner: string;
let fakeBin: string;
let env: Record<string, string>;

async function put(path: string, content: string, executable = false) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  if (executable) await chmod(path, 0o755);
}
function diff(path: string, value: string): string {
  return `diff --git a/${path} b/${path}\nindex 3367afd..3e75765 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+${value}\n`;
}
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'relik-fake-path-'));
  workspace = join(temp, 'workspace');
  runner = join(temp, 'runner');
  fakeBin = join(temp, 'fake-bin');
  const bundleRoot = join(temp, 'bundle');
  await mkdir(runner, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  await mkdir(join(runner, 'autofix-work/.git'), { recursive: true });
  for (const rel of [
    'packages/relic-ops/bin/autofix-verify-bundle.py',
    'packages/relic-ops/bin/autofix-proxy.py',
    '.github/omp-context-members.txt',
  ]) {
    await mkdir(dirname(join(workspace, rel)), { recursive: true });
    await copyFile(join(root, rel), join(workspace, rel));
  }
  const members = (
    await readFile(join(workspace, '.github/omp-context-members.txt'), 'utf8')
  )
    .trim()
    .split('\n');
  for (const member of members) await put(join(bundleRoot, member), 'fake\n');
  await put(
    join(bundleRoot, 'bin/prepare-relik.sh'),
    `#!/usr/bin/env bash\nset -eu\n[[ "$1" == --agent-db ]]\nfor n in ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN ACTIONS_RUNTIME_TOKEN OMP_VAULT_ACCESS_TOKEN GOOGLE_APPLICATION_CREDENTIALS CLOUDSDK_AUTH_ACCESS_TOKEN_FILE GITHUB_TOKEN GH_TOKEN; do [[ -z "\${!n:-}" ]] || exit 1; done\nmkdir "$RUNNER_TEMP/omp-agent" "$RUNNER_TEMP/omp-runtime"\ncp "$2" "$RUNNER_TEMP/omp-agent/agent.db"\ncp "$GITHUB_WORKSPACE/.omp-agent-context/projects/relik/runtime.py" "$RUNNER_TEMP/omp-runtime/runtime.py"\n`,
    true
  );
  await put(
    join(bundleRoot, 'projects/relik/runtime.py'),
    `import os\nfor key in ('ACTIONS_ID_TOKEN_REQUEST_URL','ACTIONS_ID_TOKEN_REQUEST_TOKEN','ACTIONS_RUNTIME_TOKEN','OMP_VAULT_ACCESS_TOKEN','GOOGLE_APPLICATION_CREDENTIALS','CLOUDSDK_AUTH_ACCESS_TOKEN_FILE','GITHUB_TOKEN','GH_TOKEN'):\n assert not os.environ.get(key)\nassert os.path.isfile(os.environ['RUNNER_TEMP']+'/omp-agent/agent.db')\n`
  );
  const bundle = join(runner, 'relik-context.tar.gz');
  execFileSync('python3', [
    '-c',
    'import pathlib,sys,tarfile; root=pathlib.Path(sys.argv[1]); names=pathlib.Path(sys.argv[2]).read_text().splitlines(); t=tarfile.open(sys.argv[3],"w:gz"); [t.add(root/n,arcname=n,recursive=False) for n in names]; t.close()',
    bundleRoot,
    join(workspace, '.github/omp-context-members.txt'),
    bundle,
  ]);
  const hash = createHash('sha256')
    .update(await readFile(bundle))
    .digest('hex');
  await put(join(workspace, '.github/omp-context.pin'), `${hash}\n`);
  const db = new Database(join(runner, 'relik-agent.db'));
  db.exec('CREATE TABLE auth_credentials (data TEXT)');
  db.query('INSERT INTO auth_credentials VALUES (?)').run(
    JSON.stringify({ access: secret })
  );
  db.close();
  await put(join(runner, 'autofix-prompt'), 'fixed safe prompt\n');
  await put(
    join(runner, 'omp-18.12.6/omp'),
    `#!/usr/bin/env bash\nset -eu\n! env | grep -Eq '^(ACTIONS_|GITHUB_TOKEN=|GH_TOKEN=)'\nscenario="$(cat "$3")"\nmkdir -p "$1/packages/relic-viewer/src" "$1/packages/relic-viewer/test" "$1/.github"\ncase "$scenario" in\n clean) printf 'new\\n' > "$1/${testPath}" ;;\n leak) printf '%s\\n' '${secret}' > "$1/${source}" ;;\n forbidden) printf 'new\\n' > "$1/.github/evil.yml" ;;\nesac\nprintf '%s\\n' '${secret}'\n`,
    true
  );
  await put(join(fakeBin, 'sudo'), '#!/usr/bin/env bash\nexit 0\n', true);
  await put(
    join(fakeBin, 'timeout'),
    '#!/usr/bin/env bash\nshift 2\nexec "$@"\n',
    true
  );
  await put(
    join(fakeBin, 'docker'),
    `#!/usr/bin/env bash\nset -eu\ncase "\${1:-} \${2:-}" in\n 'network create') exit 0 ;;\n 'network inspect') echo '127.0.0.1 127.0.0.0/8'; exit 0 ;;\n 'network rm'|'kill '*) exit 0 ;;\nesac\n[[ "$1" == run ]] || exit 1\nall=" $* "\n[[ "$all" == *"src=$RUNNER_TEMP/omp-agent,dst=$RUNNER_TEMP/omp-agent,readonly"* ]]\n[[ "$all" != *'--env GITHUB_TOKEN'* && "$all" != *'--env GH_TOKEN'* && "$all" != *'--env ACTIONS_'* ]]\nenv -i PATH="$PATH" "$RUNNER_TEMP/omp-18.12.6/omp" "$RUNNER_TEMP/autofix-work" "$RUNNER_TEMP/omp-agent/agent.db" "$RUNNER_TEMP/scenario"\n`,
    true
  );
  env = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    HOME: temp,
    RUNNER_TEMP: runner,
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: 'TheBushidoCollective/relik',
    GITHUB_TOKEN: 'fake-github-token',
    GH_TOKEN: 'fake-gh-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'fake-oidc-url',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'fake-oidc-token',
    ACTIONS_RUNTIME_TOKEN: 'fake-runtime-token',
  };
});
afterAll(async () => {
  await rm(temp, { recursive: true, force: true });
});

test('fake bundle, fake container and trusted scanner retain no fixture credentials in output or PR', async () => {
  const prepare = spawnSync(
    'bash',
    [
      bootstrap,
      join(runner, 'relik-context.tar.gz'),
      join(runner, 'relik-agent.db'),
    ],
    { env, encoding: 'utf8' }
  );
  expect(prepare.status).toBe(0);
  expect(prepare.stdout + prepare.stderr).not.toContain(secret);
  const runScenario = async (scenario: string) => {
    await put(join(runner, 'scenario'), scenario);
    return spawnSync(
      'bash',
      [
        sandbox,
        join(runner, 'autofix-work'),
        join(runner, 'autofix-prompt'),
        join(runner, 'omp-18.12.6/omp'),
        process.execPath,
      ],
      { env, encoding: 'utf8' }
    );
  };
  const clean = await runScenario('clean');
  expect(clean.status).toBe(0);
  expect(clean.stdout + clean.stderr).not.toContain(secret);
  const cleanValue = (
    await readFile(join(runner, 'autofix-work', testPath), 'utf8')
  ).trim();
  const patch = diff(testPath, cleanValue);
  const patchPath = join(temp, 'patch.diff');
  await writeFile(patchPath, patch);
  const scan = () =>
    spawnSync('bun', [scanner, patchPath, join(runner, 'omp-agent/agent.db')], {
      env,
      encoding: 'utf8',
    });
  expect(scan().status).toBe(0);
  const hash = createHash('sha256').update(patch).digest('hex');
  const result = join(temp, 'fake-result.json');
  await writeFile(
    result,
    JSON.stringify({
      status: 'pass',
      sha256: hash,
      tests: [testPath],
      baselineFailures: 1,
      passed: 1,
      fullVerify: true,
    })
  );
  const title = join(temp, 'title');
  const body = join(temp, 'body');
  const security = join(temp, 'security');
  const proposal = spawnSync(
    'bun',
    [
      prBody,
      patchPath,
      result,
      '27',
      '1'.repeat(16),
      '12345',
      title,
      body,
      security,
    ],
    { env, encoding: 'utf8' }
  );
  expect(proposal.status).toBe(0);
  expect(
    patch + (await readFile(body, 'utf8')) + proposal.stdout + proposal.stderr
  ).not.toContain(secret);
  const leak = await runScenario('leak');
  expect(leak.status).toBe(0);
  await writeFile(
    patchPath,
    diff(
      source,
      (await readFile(join(runner, 'autofix-work', source), 'utf8')).trim()
    )
  );
  const rejected = scan();
  expect(rejected.status).not.toBe(0);
  expect(rejected.stderr.trim()).toBe('Autofix patch refused');
  expect(rejected.stdout + rejected.stderr).not.toContain(secret);
  const forbidden = await runScenario('forbidden');
  expect(forbidden.status).toBe(0);
  await writeFile(patchPath, diff('.github/evil.yml', 'new'));
  expect(scan().status).not.toBe(0);
});
