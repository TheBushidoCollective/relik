import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { guardPullRequestWorkflow } from '../bin/autofix-workflow-guard.ts';

const directory = new URL('../../../.github/workflows/', import.meta.url);
const files = (await readdir(directory)).filter((name) =>
  /\.ya?ml$/.test(name)
);
const workflows = await Promise.all(
  files.map(async (name) => ({
    name,
    text: await readFile(new URL(name, directory), 'utf8'),
  }))
);
test('every PR-triggered workflow explicitly ceilings permissions and disables persisted checkout credentials', () => {
  for (const workflow of workflows)
    expect(() => guardPullRequestWorkflow(workflow.text)).not.toThrow();
});
test('PR permission guard rejects inherited or write access and credential persistence', () => {
  const base =
    'on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          persist-credentials: false\n';
  expect(() => guardPullRequestWorkflow(base)).not.toThrow();
  for (const changed of [
    base.replace('permissions:\n  contents: read\n', ''),
    base.replace('contents: read', 'contents: write'),
    base.replace('persist-credentials: false', 'persist-credentials: true'),
    base.replace(
      '    steps:\n',
      '    permissions:\n      id-token: write\n    steps:\n'
    ),
    base.replace('  pull_request:\n', '  pull_request_target:\n'),
  ])
    expect(() => guardPullRequestWorkflow(changed)).toThrow();
});
