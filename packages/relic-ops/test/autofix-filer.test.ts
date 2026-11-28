import { expect, test } from 'bun:test';
import { fingerprintOf, type ErrorReport } from '@relic/format/error-report';
import { validateEntries } from '../src/entries.ts';
import {
  DEFAULT_FILER_AUTHOR,
  GitHubRest,
  MemoryGitHub,
  type Issue,
} from '../src/github.ts';
import { applyPlan, planReports } from '../src/plan.ts';
import { issueTitle, renderRegion } from '../src/render.ts';

const fixture = (
  await Bun.file(new URL('../fixtures/reports.json', import.meta.url)).json()
).server as ErrorReport;
const now = Date.parse('2026-11-27T12:00:00Z');
const time = new Date(now - 1000).toISOString();
const authority = { commitDate: () => time, serverFrameExists: () => true };
const options = { now, autofix: 'on' as const, authority };
function entries(reports: ErrorReport[]) {
  return validateEntries(
    reports.map((report) => ({
      timestamp: time,
      severity: 'ERROR',
      jsonPayload: {
        message: 'relik error report',
        event: 'relik.error_report.v1',
        fingerprint: fingerprintOf(report),
        report,
      },
    })),
    authority,
    { now, since: now - 60_000 }
  ).entries;
}
function report(errorClass: ErrorReport['errorClass']): ErrorReport {
  return { ...fixture, errorClass };
}
function issueFor(
  value: ErrorReport,
  number: number,
  author = DEFAULT_FILER_AUTHOR
): Issue {
  const data = {
    v: 1 as const,
    fingerprint: fingerprintOf(value),
    source: value.source,
    errorClass: value.errorClass,
    route: value.route,
    builds: [{ revision: value.revision, frames: value.frames }],
    count7d: 1,
  };
  return {
    number,
    author,
    title: issueTitle(data),
    body: renderRegion(data),
    state: 'open',
    createdAt: time,
    closedAt: null,
    labels: ['error-report', 'source:server'],
    locked: true,
  };
}

class HistoryGitHub extends MemoryGitHub {
  readonly autofixBranches: Array<{ fingerprint: string }> = [];
  readonly autofixPullRequests: Array<{
    fingerprint: string;
    createdAt: string;
    state: 'open' | 'closed';
    merged: boolean;
  }> = [];
  override async autofixHistory() {
    return {
      branches: this.autofixBranches,
      pullRequests: this.autofixPullRequests,
    };
  }
}

test('live output labels only its candidates and the same issue cannot be dispatched twice', async () => {
  const github = new MemoryGitHub([], () => time);
  const input = entries([fixture]);
  const plan = await planReports(input, github, options);
  expect(plan.candidates).toHaveLength(1);
  expect(await applyPlan(plan, github, 'dry-run')).toEqual([]);
  expect(github.issues).toHaveLength(0);
  const dispatched = await applyPlan(plan, github, 'live');
  expect(dispatched).toHaveLength(1);
  expect(github.issues[0]?.labels).toContain('autofix');
  const again = await planReports(input, github, options);
  expect(again.candidates).toHaveLength(0);
});

test('recent PRs count toward the rolling cap without counting their branches twice', async () => {
  const github = new HistoryGitHub([], () => time);
  const reports = [
    report('Error'),
    report('TypeError'),
    report('RangeError'),
    report('SyntaxError'),
  ];
  github.autofixBranches.push({ fingerprint: fingerprintOf(reports[0]!) });
  github.autofixPullRequests.push({
    fingerprint: fingerprintOf(reports[0]!),
    createdAt: time,
    state: 'open',
    merged: false,
  });
  github.autofixPullRequests.push({
    fingerprint: fingerprintOf(reports[1]!),
    createdAt: time,
    state: 'open',
    merged: false,
  });
  const plan = await planReports(entries(reports), github, options);
  expect(plan.candidates).toHaveLength(1);
  expect(plan.candidates[0]?.fingerprint).not.toBe(fingerprintOf(reports[0]!));
  expect(plan.candidates[0]?.fingerprint).not.toBe(fingerprintOf(reports[1]!));
});

test('old merged PRs do not consume the cap and an old open PR blocks its fingerprint', async () => {
  const github = new HistoryGitHub([], () => time);
  const reports = [
    report('Error'),
    report('TypeError'),
    report('RangeError'),
    report('SyntaxError'),
  ];
  const old = new Date(now - 2 * 86_400_000).toISOString();
  github.autofixPullRequests.push({
    fingerprint: fingerprintOf(reports[0]!),
    createdAt: old,
    state: 'open',
    merged: false,
  });
  github.autofixPullRequests.push({
    fingerprint: fingerprintOf(reports[1]!),
    createdAt: old,
    state: 'closed',
    merged: true,
  });
  const plan = await planReports(entries(reports), github, options);
  expect(plan.candidates).toHaveLength(3);
  expect(
    plan.candidates.some(
      (candidate) => candidate.fingerprint === fingerprintOf(reports[0]!)
    )
  ).toBe(false);
});

test('old branches do not consume the cap, but block their fingerprint; closed unmerged PRs block redispatch', async () => {
  const github = new HistoryGitHub([], () => time);
  const reports = [
    report('Error'),
    report('TypeError'),
    report('RangeError'),
    report('SyntaxError'),
    report('EvalError'),
  ];
  const old = new Date(now - 2 * 86_400_000).toISOString();
  github.autofixBranches.push({ fingerprint: fingerprintOf(reports[0]!) });
  github.autofixPullRequests.push({
    fingerprint: fingerprintOf(reports[1]!),
    createdAt: old,
    state: 'closed',
    merged: false,
  });
  const plan = await planReports(entries(reports), github, options);
  expect(plan.candidates).toHaveLength(3);
  expect(
    plan.candidates.some(
      (candidate) => candidate.fingerprint === fingerprintOf(reports[0]!)
    )
  ).toBe(false);
  expect(
    plan.candidates.some(
      (candidate) => candidate.fingerprint === fingerprintOf(reports[1]!)
    )
  ).toBe(false);
});

test('a label event and PR for the same fingerprint consume one dispatch slot', async () => {
  const reports = [
    report('Error'),
    report('TypeError'),
    report('RangeError'),
    report('SyntaxError'),
  ];
  const first = issueFor(reports[0]!, 1);
  first.labels.push('autofix');
  const github = new HistoryGitHub([first], () => time);
  github.labelEvents.set(1, [time]);
  github.autofixPullRequests.push({
    fingerprint: fingerprintOf(reports[0]!),
    createdAt: time,
    state: 'open',
    merged: false,
  });
  github.autofixPullRequests.push({
    fingerprint: fingerprintOf(reports[1]!),
    createdAt: time,
    state: 'closed',
    merged: false,
  });
  const plan = await planReports(entries(reports), github, options);
  expect(plan.candidates).toHaveLength(1);
});

test('isolated authenticated bot issues still consume creation and dispatch slots', async () => {
  const existing = (
    ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError'] as const
  ).map((name, index) => issueFor(report(name), index + 1));
  existing[4]!.title = 'Damaged issue title';
  existing[4]!.body = 'Damaged report body';
  existing[4]!.labels = ['source:server'];
  const github = new MemoryGitHub(existing, () => time);
  const fresh = report('URIError');
  const plan = await planReports(entries([fresh]), github, options);
  expect(
    plan.actions.filter((action) => action.kind === 'create')
  ).toHaveLength(0);

  for (const issue of existing.slice(0, 3)) {
    issue.title = 'Damaged issue title';
    issue.body = 'Damaged report body';
    issue.labels = ['autofix'];
  }
  const dispatched = new MemoryGitHub(existing.slice(0, 3), () => time);
  for (const issue of existing.slice(0, 3))
    dispatched.labelEvents.set(issue.number, [time]);
  const plan2 = await planReports(entries([fresh]), dispatched, options);
  expect(plan2.candidates).toHaveLength(0);
});

test('REST reads exact branch and PR names, excludes forks and preserves closed status', async () => {
  const fp = fingerprintOf(fixture);
  const request = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/git/matching-refs/'))
      return Response.json([
        { ref: `refs/heads/autofix/error-${fp}` },
        { ref: `refs/heads/autofix/error-${fp}-extra` },
      ]);
    if (url.includes('/pulls?'))
      return Response.json([
        {
          head: {
            ref: `autofix/error-${fp}`,
            repo: { full_name: 'TheBushidoCollective/relik' },
          },
          created_at: time,
          state: 'closed',
          merged_at: null,
        },
        {
          head: {
            ref: `autofix/error-${fp}`,
            repo: { full_name: 'somebody/fork' },
          },
          created_at: time,
          state: 'open',
          merged_at: null,
        },
        {
          head: {
            ref: 'other',
            repo: { full_name: 'TheBushidoCollective/relik' },
          },
          created_at: time,
          state: 'open',
          merged_at: null,
        },
      ]);
    throw new Error('Unexpected request');
  };
  const history = await new GitHubRest('fixture', request).autofixHistory();
  expect(history.branches).toEqual([{ fingerprint: fp }]);
  expect(history.pullRequests).toEqual([
    { fingerprint: fp, createdAt: time, state: 'closed', merged: false },
  ]);
});

test('a foreign issue cannot be labeled or passed as fixer input', async () => {
  const foreign = issueFor(fixture, 9, {
    login: 'someone',
    id: 91,
    type: 'User',
  });
  const github = new MemoryGitHub([foreign], () => time);
  const plan = await planReports(entries([fixture]), github, options);
  const dispatched = await applyPlan(plan, github, 'live');
  expect(dispatched).toHaveLength(1);
  expect(dispatched[0]?.issue).not.toBe(foreign.number);
  expect(
    github.issues.find((candidate) => candidate.number === foreign.number)
      ?.labels
  ).not.toContain('autofix');
});
