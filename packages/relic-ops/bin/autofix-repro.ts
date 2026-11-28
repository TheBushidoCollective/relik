import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  fstatSync,
  mkdirSync,
  openSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { checkPatch } from '../src/patch-policy.ts';
import {
  passesOriginalTests,
  proveRegression,
  type TestRun,
} from '../src/repro.ts';

let scratch: string | undefined;
try {
  if (
    (process.argv.length !== 4 && process.argv.length !== 5) ||
    (process.argv.length === 5 && process.argv[4] !== '--fixture') ||
    !process.env.GITHUB_WORKSPACE ||
    !process.env.RUNNER_TEMP
  )
    throw new Error('arguments');
  const [patchPath, resultPath] = process.argv.slice(2) as [string, string];
  if (statSync(patchPath).size > 200_000) throw new Error('size');
  const patchBytes = readFileSync(patchPath);
  const patch = new TextDecoder('utf-8', { fatal: true }).decode(patchBytes);
  const summary = checkPatch(patch);
  if (summary.tests.length === 0) throw new Error('no regression test');
  scratch = mkdtempSync(join(process.env.RUNNER_TEMP, 'autofix-repro-'));
  const baseline = join(scratch, 'baseline');
  const fixed = join(scratch, 'fixed');
  const original = join(scratch, 'original');
  cpSync(process.env.GITHUB_WORKSPACE, baseline, {
    recursive: true,
    dereference: false,
  });
  cpSync(process.env.GITHUB_WORKSPACE, fixed, {
    recursive: true,
    dereference: false,
  });
  cpSync(process.env.GITHUB_WORKSPACE, original, {
    recursive: true,
    dereference: false,
  });
  if (process.argv[4] === '--fixture') {
    const fixture = join(
      process.env.GITHUB_WORKSPACE,
      'packages/relic-ops/fixtures/autofix/canary.ts'
    );
    for (const directory of [baseline, fixed, original])
      copyFileSync(
        fixture,
        join(directory, 'packages/relic-format/src/autofix-canary.ts')
      );
  }
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const includes = summary.files
    .filter((path) => path.includes('/test/'))
    .map((path) => `--include=${path}`);
  execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', 'apply', ...includes, patchPath],
    { cwd: baseline, env: gitEnv, stdio: 'ignore' }
  );
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'apply', patchPath], {
    cwd: fixed,
    env: gitEnv,
    stdio: 'ignore',
  });
  const sourceIncludes = summary.files
    .filter((path) => path.includes('/src/'))
    .map((path) => `--include=${path}`);
  if (!sourceIncludes.length) throw new Error('no source change');
  execFileSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', 'apply', ...sourceIncludes, patchPath],
    {
      cwd: original,
      env: gitEnv,
      stdio: 'ignore',
    }
  );
  const originalPackages = [
    ...new Set(summary.files.map((path) => path.split('/')[1]!)),
  ].sort();
  const originalTests = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--',
      ...originalPackages.map((name) => `packages/${name}/test`),
    ],
    {
      cwd: process.env.GITHUB_WORKSPACE,
      env: gitEnv,
      encoding: 'utf8',
      maxBuffer: 2_000_000,
    }
  )
    .split('\0')
    .filter((path) => /\.test\.ts$/.test(path));
  if (
    !originalPackages.every((name) =>
      originalTests.some((path) => path.startsWith(`packages/${name}/test/`))
    )
  )
    throw new Error('no original tests');
  let baselineResult: TestRun | undefined;
  let fixedResult: TestRun | undefined;
  const run = async (
    phase: 'baseline' | 'fixed' | 'original',
    tests: readonly string[]
  ) => {
    const dir = join(scratch!, `${phase}-result`);
    mkdirSync(dir, { mode: 0o700 });
    const work =
      phase === 'baseline' ? baseline : phase === 'fixed' ? fixed : original;
    const run = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--log-driver=none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--user',
        `${process.getuid!()}:${process.getgid!()}`,
        '--pids-limit',
        '256',
        '--memory',
        '3g',
        '--ulimit',
        'fsize=1048576:1048576',
        '--tmpfs',
        '/tmp:rw,nosuid,nodev,size=256m',
        '--tmpfs',
        '/home/agent:rw,nosuid,nodev,size=128m',
        '--mount',
        `type=bind,src=${work},dst=/workspace`,
        '--mount',
        `type=bind,src=${dir},dst=/result`,
        '--mount',
        `type=bind,src=${process.execPath},dst=/usr/local/bin/bun,readonly`,
        '--workdir',
        '/workspace',
        '--env',
        'HOME=/home/agent',
        '--env',
        'LANG=C.UTF-8',
        'relik-autofix-sandbox',
        '/bin/bash',
        '-c',
        'set -euo pipefail; [[ $$ == 1 && "$(id -u)" != 0 && ! -S /var/run/docker.sock ]]; ! command -v sudo >/dev/null 2>&1; ! env | cut -d= -f1 | grep -Eq "^(ACTIONS_|GITHUB_TOKEN$|GH_TOKEN$)"; exec timeout --kill-after=5s 300s bun test --reporter=junit --reporter-outfile=/result/result.xml "$@" >/dev/null 2>&1',
        'repro',
        ...tests,
      ],
      { stdio: 'ignore', timeout: 310_000 }
    );
    let result: TestRun = {
      exitCode: run.status ?? -1,
      passed: 0,
      failed: 0,
      errors: 1,
    };
    const xmlPath = join(dir, 'result.xml');
    try {
      const fd = openSync(
        xmlPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      );
      let xml: string;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > 1_048_576)
          throw new Error('report size');
        xml = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
      const root = /<testsuites\s+([^>]+)>/.exec(xml)?.[1] ?? '';
      const attr = (name: string) =>
        Number(new RegExp(`(?:^|\\s)${name}="(\\d+)"`).exec(root)?.[1] ?? -1);
      const total = attr('tests');
      const failed = attr('failures');
      const skipped = attr('skipped');
      if (
        [total, failed, skipped].some(
          (n) => !Number.isSafeInteger(n) || n < 0
        ) ||
        total > 1_000_000 ||
        failed > total ||
        skipped > total
      )
        throw new Error('report');
      const assertedFailure = /<failure\b[^>]*\btype="AssertionError"/.test(
        xml
      );
      const errors =
        /<error(?:\s|>)/.test(xml) || (failed > 0 && !assertedFailure) ? 1 : 0;
      result = {
        exitCode: run.status ?? -1,
        failed,
        passed: total - failed - skipped,
        errors,
      };
    } catch {
      /* An absent or invalid report is a test error, not reproduction. */
    }
    if (phase === 'baseline') baselineResult = result;
    else if (phase === 'fixed') fixedResult = result;
    return result;
  };
  const accepted = await proveRegression(summary.tests, run);
  if (!accepted || !baselineResult || !fixedResult) throw new Error('unproven');
  const originalResult = await run('original', originalTests);
  if (!passesOriginalTests(originalResult)) throw new Error('original tests');
  writeFileSync(
    resultPath,
    `${JSON.stringify({
      status: 'pass',
      sha256: createHash('sha256').update(patchBytes).digest('hex'),
      tests: summary.tests,
      baselineFailures: baselineResult.failed,
      passed: fixedResult.passed,
      originalPackages,
      originalPassed: originalResult.passed,
    })}\n`,
    { mode: 0o600, flag: 'wx' }
  );
} catch {
  process.stderr.write('Autofix regression proof refused\n');
  process.exitCode = 1;
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}
