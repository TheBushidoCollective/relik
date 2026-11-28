import { expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const script = new URL('../bin/autofix-repro.ts', import.meta.url).pathname;
const source = 'packages/relic-viewer/src/example.ts';
const originalTest = 'packages/relic-viewer/test/existing.test.ts';
const regressionTest = 'packages/relic-viewer/test/new.test.ts';
const patch = `diff --git a/${source} b/${source}\nindex 3367afd..3e75765 100644\n--- a/${source}\n+++ b/${source}\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/${regressionTest} b/${regressionTest}\nnew file mode 100644\nindex 0000000..3e75765\n--- /dev/null\n+++ b/${regressionTest}\n@@ -0,0 +1 @@\n+new\n`;

test('replay runs untouched original tests with fixed source and rejects an original failure or symlink report', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'relik-replay-test-'));
  try {
    const workspace = join(temp, 'workspace');
    const bin = join(temp, 'bin');
    for (const [name, content] of [
      [source, 'old\n'],
      [originalTest, 'old\n'],
    ]) {
      const path = join(workspace, name!);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content!);
    }
    execFileSync('git', ['init', '-q', workspace]);
    execFileSync('git', ['-C', workspace, 'add', '.']);
    await mkdir(bin);
    const docker = join(bin, 'docker');
    await writeFile(
      docker,
      `#!/usr/bin/env bash\nset -euo pipefail\nresult=''\nwork=''\nfor value in "$@"; do\n case "$value" in\n  type=bind,src=*,dst=/result) result="\${value#type=bind,src=}"; result="\${result%,dst=/result}" ;;\n  type=bind,src=*,dst=/workspace) work="\${value#type=bind,src=}"; work="\${work%,dst=/workspace}" ;;\n esac\ndone\n[[ -n "$result" && -n "$work" ]]\ncase "$result" in\n */baseline-result) [[ "$(cat "$work/${source}")" == old ]]; [[ " $* " == *' ${regressionTest} '* ]]; status=1 ;;\n */fixed-result) [[ "$(cat "$work/${source}")" == new ]]; [[ " $* " == *' ${regressionTest} '* ]]; status=0 ;;\n */original-result) [[ "$(cat "$work/${source}")" == new ]]; [[ "$(cat "$work/${originalTest}")" == old ]]; [[ " $* " == *' ${originalTest} '* ]]; [[ " $* " != *' ${regressionTest} '* ]]; status="\${FAIL_ORIGINAL:-0}" ;;\n *) exit 2 ;;\nesac\nif [[ "\${SYMLINK_REPORT:-0}" == 1 ]]; then ln -s "$FAKE_REPORT" "$result/result.xml"; else\n printf '<testsuites tests="1" failures="%s" skipped="0">' "$status" > "$result/result.xml"\n if [[ "$status" == 1 ]]; then printf '<failure type="AssertionError" />' >> "$result/result.xml"; fi\n printf '</testsuites>' >> "$result/result.xml"\nfi\nexit "$status"\n`
    );
    await chmod(docker, 0o755);
    const diff = join(temp, 'patch.diff');
    await writeFile(diff, patch);
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: temp,
    };
    const result = join(temp, 'result.json');
    const good = spawnSync('bun', [script, diff, result], {
      env,
      encoding: 'utf8',
    });
    expect(good.status).toBe(0);
    const evidence = JSON.parse(await readFile(result, 'utf8'));
    expect(evidence.originalPackages).toEqual(['relic-viewer']);
    expect(evidence.originalPassed).toBe(1);
    const bad = spawnSync('bun', [script, diff, join(temp, 'bad.json')], {
      env: { ...env, FAIL_ORIGINAL: '1' },
      encoding: 'utf8',
    });
    expect(bad.status).not.toBe(0);
    const link = spawnSync('bun', [script, diff, join(temp, 'link.json')], {
      env: { ...env, SYMLINK_REPORT: '1', FAKE_REPORT: result },
      encoding: 'utf8',
    });
    expect(link.status).not.toBe(0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
