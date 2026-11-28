import { describe, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ErrorReport, fingerprintOf } from '@relic/format/error-report';
import { createErrorReporter } from '../../relic-server/src/error-report.ts';
import { validateEntries } from '../src/entries.ts';
import * as githubModule from '../src/github.ts';
import { type Issue, GitHubRest, MemoryGitHub } from '../src/github.ts';
import { applyPlan, planReports } from '../src/plan.ts';
import { issueTitle, parseRegion, renderRegion } from '../src/render.ts';

const fixtures = (await Bun.file(
  new URL('../fixtures/reports.json', import.meta.url)
).json()) as {
  server: ErrorReport;
  viewer: ErrorReport;
  mcp: ErrorReport;
  issueFrames: {
    server: ErrorReport['frames'];
    viewer: Array<{ file: string }>;
    mcp: Array<{ file: string }>;
  };
};
const now = Date.parse('2026-11-27T12:00:00Z');
const timestamp = new Date(now - 1000).toISOString();
const revision = fixtures.server.revision;
const bot = { login: 'github-actions[bot]', id: 41898282, type: 'Bot' };
const human = { login: 'someone', id: 12345, type: 'User' };
const authority = {
  commitDate: (_source: ErrorReport['source'], value: string) =>
    value === revision || value === fixtures.mcp.revision ? timestamp : null,
  serverFrameExists: (_revision: string, _file: string, line: number) =>
    line <= 100,
};

function checked(reports: ErrorReport[]) {
  const result = validateEntries(
    reports.map((report) => ({
      timestamp,
      severity: 'ERROR',
      jsonPayload: {
        message: 'relik error report',
        event: 'relik.error_report.v1',
        fingerprint: fingerprintOf(report),
        report,
      },
    })),
    authority,
    { now, since: 0 }
  );
  assert.equal(result.entries.length, reports.length);
  return result.entries;
}

function serverReport(errorClass: ErrorReport['errorClass']): ErrorReport {
  return { ...structuredClone(fixtures.server), errorClass };
}

function issueFor(report: ErrorReport, number: number, author = bot) {
  const data = {
    v: 1 as const,
    fingerprint: fingerprintOf(report),
    source: report.source,
    errorClass: report.errorClass,
    route: report.route,
    builds: [{ revision: report.revision, frames: report.frames }],
    count7d: 3,
  };
  return {
    number,
    author,
    title: issueTitle(data),
    body: renderRegion(data),
    state: 'open' as const,
    createdAt: timestamp,
    closedAt: null,
    labels: ['error-report', `source:${report.source}`],
    locked: false,
  };
}

function apiIssue(issue: Issue) {
  return {
    number: issue.number,
    user: issue.author,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    created_at: issue.createdAt,
    closed_at: issue.closedAt,
    labels: issue.labels.map((name) => ({ name })),
    locked: issue.locked,
  };
}

const options = { now, autofix: 'on' as const, authority };

describe('filer provenance and stored-region authority', () => {
  test('REST carries the author and rejects login, id, type, missing-author and pull-request impersonation', async () => {
    const base = issueFor(fixtures.server, 1);
    const values = [
      apiIssue(base),
      { ...apiIssue(base), number: 2, user: human },
      { ...apiIssue(base), number: 3, user: { ...bot, id: 1 } },
      { ...apiIssue(base), number: 4, user: { ...bot, type: 'User' } },
      { ...apiIssue(base), number: 5, user: { ...bot, login: 'other[bot]' } },
      { ...apiIssue(base), number: 6, user: null },
      { ...apiIssue(base), number: 7, pull_request: {} },
    ];
    const request = async () => Response.json(values);
    const github = new GitHubRest('fake-token', request);
    const issues = await github.listIssues();
    assert.deepEqual(
      issues.map((issue) => issue.number),
      [1]
    );
    assert.deepEqual(issues[0]?.author, bot);
    const created = await new GitHubRest('fake-token', async () =>
      Response.json(apiIssue(base))
    ).createIssue(base.title, base.body, base.labels);
    assert.deepEqual(created.author, bot);
  });

  test('planner ignores foreign claims, caps and autofix events before creating a matching report', async () => {
    const target = serverReport('TypeError');
    const foreign = [
      issueFor(target, 1, human),
      ...(
        ['Error', 'RangeError', 'SyntaxError', 'URIError', 'EvalError'] as const
      ).map((name, index) => issueFor(serverReport(name), index + 2, human)),
    ];
    const github = new MemoryGitHub(foreign, () => timestamp);
    for (const issue of foreign)
      github.labelEvents.set(issue.number, [timestamp]);
    const before = structuredClone(github.issues);
    const plan = await planReports(checked([target]), github, options);
    assert.deepEqual(
      plan.actions.map((action) => action.kind),
      ['create']
    );
    assert.equal(plan.candidates.length, 1);
    assert.equal(plan.candidates[0]?.issue, null);
    await applyPlan(plan, github, 'live');
    assert.deepEqual(github.issues.slice(0, foreign.length), before);
  });

  for (const claim of ['copied title', 'marker and label'] as const) {
    test(`foreign issue with ${claim} cannot claim a fingerprint`, async () => {
      const target = serverReport('TypeError');
      const foreign = issueFor(target, 1, human);
      if (claim === 'copied title') {
        foreign.body = 'A public issue.';
        foreign.labels = [];
      } else {
        foreign.title = 'A public issue';
      }
      const github = new MemoryGitHub([foreign]);
      const before = structuredClone(github.issues[0]);
      const plan = await planReports(checked([target]), github, {
        ...options,
        autofix: 'off',
      });
      assert.deepEqual(
        plan.actions.map((action) => action.kind),
        ['create']
      );
      await applyPlan(plan, github, 'live');
      assert.deepEqual(github.issues[0], before);
    });
  }

  test('isolates duplicate and malformed fingerprints while unrelated fresh and stale reports continue', async () => {
    const duplicate = serverReport('TypeError');
    const malformed = serverReport('RangeError');
    const stale = serverReport('SyntaxError');
    const fresh = serverReport('URIError');
    const damaged = issueFor(malformed, 3);
    damaged.body = damaged.body.replace(
      'Counts are lower bounds.',
      'untrusted replacement'
    );
    const github = new MemoryGitHub([
      issueFor(duplicate, 1),
      issueFor(duplicate, 2),
      damaged,
      issueFor(stale, 4),
    ]);
    const before = structuredClone(github.issues);
    const plan = await planReports(
      checked([duplicate, malformed, fresh]),
      github,
      {
        ...options,
        autofix: 'off',
      }
    );
    assert.deepEqual(plan.isolated, { invalid: 1, duplicate: 1 });
    assert.deepEqual(
      plan.actions.map((action) => [action.kind, action.fingerprint]),
      [
        ['create', fingerprintOf(fresh)],
        ['update', fingerprintOf(stale)],
        ['lock', fingerprintOf(stale)],
      ]
    );
    await applyPlan(plan, github, 'live');
    assert.deepEqual(github.issues.slice(0, 3), before.slice(0, 3));
    assert.equal(parseRegion(github.issues[3]!.body)?.count7d, 0);
  });

  test('checks every stored build and server source line before active updates, stale decay or locks', async () => {
    const invalidRevision = serverReport('TypeError');
    const invalidFrame = serverReport('RangeError');
    const control = serverReport('SyntaxError');
    const unknown = { ...invalidRevision, revision: 'b'.repeat(40) };
    const outsideFile = {
      ...invalidFrame,
      frames: invalidFrame.frames.map((frame) => ({ ...frame, line: 999 })),
    };
    const first = issueFor(invalidRevision, 1);
    const data = parseRegion(first.body)!;
    first.body = renderRegion({
      ...data,
      builds: [
        data.builds[0]!,
        { revision: unknown.revision, frames: unknown.frames },
      ],
    });
    const second = issueFor(outsideFile, 2);
    const github = new MemoryGitHub([first, second]);
    const before = structuredClone(github.issues);
    const plan = await planReports(
      checked([invalidRevision, control]),
      github,
      {
        ...options,
        autofix: 'off',
        known: {
          revisions: new Set([revision, unknown.revision]),
          mcpVersions: new Set([fixtures.mcp.revision]),
        },
      }
    );
    assert.deepEqual(plan.isolated, { invalid: 2, duplicate: 0 });
    assert.deepEqual(
      plan.actions.map((action) => [action.kind, action.fingerprint]),
      [['create', fingerprintOf(control)]]
    );
    await applyPlan(plan, github, 'live');
    assert.deepEqual(github.issues.slice(0, 2), before);
  });

  test('isolates a self-consistent stored server frame when its source file is absent', async () => {
    const missing = 'packages/relic-server/src/absent.ts';
    const report = {
      ...serverReport('TypeError'),
      frames: [{ file: missing, line: 1, column: 0 }],
    };
    const github = new MemoryGitHub([issueFor(report, 1)]);
    const plan = await planReports([], github, {
      ...options,
      authority: {
        ...authority,
        serverFrameExists: (_revision: string, file: string) =>
          file !== missing,
      },
    });
    assert.deepEqual(plan.isolated, { invalid: 1, duplicate: 0 });
    assert.equal(plan.actions.length, 0);
    assert.equal(github.writes, 0);
  });

  test('does not decay a stored MCP issue whose release tag is unknown', async () => {
    const initial = await planReports(
      checked([fixtures.mcp]),
      new MemoryGitHub(),
      options
    );
    const created = initial.actions.find((action) => action.kind === 'create');
    assert.ok(created && created.kind === 'create');
    const body = created.body.replaceAll(fixtures.mcp.revision, '9.9.9');
    const issue = {
      ...issueFor(fixtures.server, 1),
      title: created.title,
      body,
      labels: ['error-report', 'source:mcp'],
    };
    const github = new MemoryGitHub([issue]);
    const plan = await planReports([], github, options);
    assert.deepEqual(plan.isolated, { invalid: 1, duplicate: 0 });
    assert.equal(plan.actions.length, 0);
    assert.equal(github.issues[0]?.body, body);
  });

  test('rejects an unknown stored build before consulting the Git authority', async () => {
    const report = serverReport('TypeError');
    const forged = { ...report, revision: 'b'.repeat(40) };
    const github = new MemoryGitHub([issueFor(forged, 1)]);
    let calls = 0;
    const permissiveAuthority = {
      ...authority,
      commitDate: () => {
        calls++;
        return timestamp;
      },
    };
    const plan = await planReports(checked([report]), github, {
      ...options,
      authority: permissiveAuthority,
      known: { revisions: new Set([revision]) },
    });
    assert.equal(calls, 0);
    assert.deepEqual(plan.isolated, { invalid: 1, duplicate: 0 });
    assert.equal(plan.actions.length, 0);
  });

  test('isolates both claims from a title and canonical region with conflicting fingerprints', async () => {
    const bodyReport = serverReport('TypeError');
    const titleReport = serverReport('RangeError');
    const control = serverReport('URIError');
    const issue = issueFor(bodyReport, 1);
    issue.title = issueFor(titleReport, 2).title;
    const github = new MemoryGitHub([issue]);
    const plan = await planReports(
      checked([bodyReport, titleReport, control]),
      github,
      { ...options, autofix: 'off' }
    );
    assert.deepEqual(plan.isolated, { invalid: 1, duplicate: 0 });
    assert.deepEqual(
      plan.actions.map((action) => action.fingerprint),
      [fingerprintOf(control)]
    );
    assert.equal(plan.actions[0]?.kind, 'create');
  });

  test('honors an explicitly configured filer identity in both REST and planner', async () => {
    const alternate = { login: 'reporter[bot]', id: 987, type: 'Bot' };
    const matching = issueFor(fixtures.server, 1, alternate);
    const other = issueFor(serverReport('RangeError'), 2, bot);
    const github = new GitHubRest(
      'fake-token',
      async () => Response.json([apiIssue(matching), apiIssue(other)]),
      alternate
    );
    assert.deepEqual(
      (await github.listIssues()).map((issue) => issue.number),
      [1]
    );
    const memory = new MemoryGitHub(
      [matching, other],
      () => timestamp,
      alternate
    );
    const plan = await planReports(checked([fixtures.server]), memory, {
      ...options,
      filerAuthor: alternate,
    });
    assert.ok(
      plan.actions.some(
        (action) => action.kind === 'lock' && action.issue === 1
      )
    );
    assert.ok(
      plan.actions.every((action) => !('issue' in action) || action.issue !== 2)
    );
  });

  test('uses the pinned author by default and validates environment overrides', () => {
    const fromEnv = githubModule.filerAuthorFromEnv;
    assert.ok(fromEnv);
    assert.deepEqual(fromEnv({}), bot);
    assert.deepEqual(
      fromEnv({
        ERROR_REPORT_FILER_LOGIN: 'reporter[bot]',
        ERROR_REPORT_FILER_ID: '987',
        ERROR_REPORT_FILER_TYPE: 'Bot',
      }),
      { login: 'reporter[bot]', id: 987, type: 'Bot' }
    );
    for (const id of ['', '0', '-1', '1.5', '9007199254740992'])
      assert.throws(() => fromEnv({ ERROR_REPORT_FILER_ID: id }));
  });
});

test('continuity after reporter fix: filer retains known MCP counts when unknown builds share the fingerprint', async () => {
  const emitted: string[] = [];
  let elapsed = 0;
  const reporter = createErrorReporter({
    revision,
    now: () => elapsed,
    emit: (line) => emitted.push(line),
  });
  const first = { ...fixtures.mcp, revision: '1.2.3' };
  const second = { ...fixtures.mcp, revision: '1.2.4' };
  const unknown = { ...fixtures.mcp, revision: '9.9.9' };
  for (const report of [first, first, second, second, unknown, unknown])
    reporter.client(report);
  elapsed = 600_000;
  reporter.client(unknown);

  const releaseAuthority = {
    ...authority,
    commitDate: (_source: ErrorReport['source'], value: string) =>
      value === first.revision || value === second.revision ? timestamp : null,
  };
  const known = { mcpVersions: new Set([first.revision, second.revision]) };
  const result = validateEntries(
    emitted.map((line) => ({ timestamp, jsonPayload: JSON.parse(line) })),
    releaseAuthority,
    { now, since: 0, known }
  );
  const counts = new Map<string, number>();
  for (const entry of result.entries) {
    counts.set(
      entry.report.revision,
      (counts.get(entry.report.revision) ?? 0) + entry.report.count
    );
  }
  assert.deepEqual(
    [...counts],
    [
      [first.revision, 2],
      [second.revision, 2],
    ]
  );
  assert.equal(result.dropped.revision, 2);
  const plan = await planReports(result.entries, new MemoryGitHub(), {
    ...options,
    autofix: 'off',
    authority: releaseAuthority,
    known,
  });
  const action = plan.actions.find((item) => item.kind === 'create');
  assert.ok(action && action.kind === 'create');
  const issue = parseRegion(action.body);
  assert.equal(issue?.count7d, 4);
  assert.deepEqual(
    new Set(issue?.builds.map((build) => build.revision)),
    known.mcpVersions
  );
});

describe('public frame positions', () => {
  test('omits all viewer and MCP positions in prose and JSON while preserving fingerprints and server positions', async () => {
    const viewer = {
      ...structuredClone(fixtures.viewer),
      frames: fixtures.viewer.frames.map((frame) => ({
        ...frame,
        line: 9999999,
        column: 8765432,
      })),
    };
    const mcp = {
      ...structuredClone(fixtures.mcp),
      frames: fixtures.mcp.frames.map((frame) => ({
        ...frame,
        line: 9999999,
        column: 8765432,
      })),
    };
    const plan = await planReports(
      checked([viewer, mcp, fixtures.server]),
      new MemoryGitHub(),
      options
    );
    for (const report of [viewer, mcp]) {
      const action = plan.actions.find(
        (item) =>
          item.kind === 'create' && item.fingerprint === fingerprintOf(report)
      );
      assert.ok(action && action.kind === 'create');
      assert.doesNotMatch(action.body, /9999999|8765432|"line"|"column"/);
      assert.ok(action.body.includes(`- \`${report.frames[0]!.file}\``));
      const data = parseRegion(action.body);
      assert.equal(data?.fingerprint, fingerprintOf(report));
      assert.deepEqual(
        data?.builds[0]?.frames,
        fixtures.issueFrames[report.source as 'viewer' | 'mcp']
      );
    }
    const server = plan.actions.find(
      (item) =>
        item.kind === 'create' &&
        item.fingerprint === fingerprintOf(fixtures.server)
    );
    assert.ok(server && server.kind === 'create');
    const frame = fixtures.server.frames[0]!;
    assert.ok(
      server.body.includes(`- \`${frame.file}:${frame.line}:${frame.column}\``)
    );
    assert.deepEqual(
      parseRegion(server.body)?.builds[0]?.frames,
      fixtures.issueFrames.server
    );
  });

  test('preserves chunk-normalized file fingerprints when client positions and bundle names change', async () => {
    const first = {
      ...structuredClone(fixtures.viewer),
      frames: [{ file: 'assets/chunk-abcd1234.js', line: 3, column: 7 }],
    };
    const second = {
      ...first,
      frames: [
        { file: 'assets/chunk-1234abcd.js', line: 9999999, column: 8765432 },
      ],
    };
    assert.equal(fingerprintOf(first), fingerprintOf(second));
    const plan = await planReports(
      checked([first, second]),
      new MemoryGitHub(),
      options
    );
    const creates = plan.actions.filter((action) => action.kind === 'create');
    assert.equal(creates.length, 1);
    const created = creates[0];
    assert.ok(created && created.kind === 'create');
    const data = parseRegion(created.body);
    assert.equal(data?.fingerprint, fingerprintOf(first));
    assert.equal(data?.count7d, 2);
    assert.deepEqual(Object.keys(data?.builds[0]?.frames[0] ?? {}), ['file']);
  });

  test('isolates a legacy client region containing unverified JSON positions without rewriting it', async () => {
    const report = fixtures.viewer;
    const data = {
      v: 1,
      fingerprint: fingerprintOf(report),
      source: report.source,
      errorClass: report.errorClass,
      route: report.route,
      builds: [{ revision: report.revision, frames: report.frames }],
      count7d: 3,
    };
    const frame = report.frames[0]!;
    const body = [
      '<!-- relik-error-report:begin -->',
      'This report contains only allowlisted diagnostic fields. Counts are lower bounds.',
      '',
      '| Field | Value |',
      '| --- | --- |',
      `| Source | ${report.source} |`,
      `| Class | ${report.errorClass} |`,
      `| Route | ${report.route} |`,
      '| Occurrences in the last 7 days | at least 3 |',
      `| Builds seen | \`${report.revision}\` |`,
      '',
      'Frames from the newest build:',
      `- \`${frame.file}:${frame.line}:${frame.column}\``,
      '',
      '```json',
      JSON.stringify(data, null, 2),
      '```',
      '<!-- relik-error-report:end -->',
    ].join('\n');
    const issue = {
      ...issueFor(fixtures.server, 1),
      title: `Error report: ${report.errorClass} in ${report.source} ${report.route} [${fingerprintOf(report)}]`,
      body,
      labels: ['error-report', 'source:viewer'],
    };
    const github = new MemoryGitHub([issue]);
    const plan = await planReports(checked([report]), github, options);
    assert.equal(parseRegion(body), null);
    assert.deepEqual(plan.isolated, { invalid: 1, duplicate: 0 });
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.candidates.length, 0);
    await applyPlan(plan, github, 'live');
    assert.equal(github.issues[0]?.body, body);
    assert.equal(github.writes, 0);
  });
});

test('Git authority peels annotated and lightweight release tags before reading commit dates', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'relik-release-tags-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  try {
    git('init', '-q');
    await writeFile(join(repo, 'file.txt'), 'release\n');
    git('add', 'file.txt');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '-m',
      'release'
    );
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'tag.gpgsign=false',
      'tag',
      '-a',
      'relic-mcp-v1.2.3',
      '-m',
      'annotated release'
    );
    git('-c', 'tag.gpgsign=false', 'tag', 'relic-mcp-v1.2.4');
    const commitDate = new Date(
      git('show', '-s', '--format=%cI', 'HEAD')
    ).toISOString();
    const moduleUrl = new URL('../src/entries.ts', import.meta.url).href;
    const script = `import { GitAuthority } from ${JSON.stringify(moduleUrl)}; const a = new GitAuthority(); console.log(JSON.stringify([a.commitDate('mcp', '1.2.3'), a.commitDate('mcp', '1.2.4'), a.commitDate('mcp', '9.9.9')]));`;
    const result = Bun.spawnSync([process.execPath, '-e', script], {
      cwd: repo,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(result.exitCode, 0, result.stderr.toString());
    assert.deepEqual(JSON.parse(result.stdout.toString()), [
      commitDate,
      commitDate,
      null,
    ]);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});
