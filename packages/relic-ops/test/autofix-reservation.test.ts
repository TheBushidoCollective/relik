import { expect, test } from 'bun:test';
import { fingerprintOf, type ErrorReport } from '@relic/format/error-report';
import { validateEntries } from '../src/entries.ts';
import { MemoryGitHub } from '../src/github.ts';
import { applyPlan, planReports } from '../src/plan.ts';

const report = (
  await Bun.file(new URL('../fixtures/reports.json', import.meta.url)).json()
).server as ErrorReport;
const now = Date.parse('2026-11-27T12:00:00Z');
const authority = {
  commitDate: () => new Date(now - 1000).toISOString(),
  serverFrameExists: () => true,
};
const input = validateEntries(
  [
    {
      timestamp: new Date(now - 1000).toISOString(),
      severity: 'ERROR',
      jsonPayload: {
        message: 'relik error report',
        event: 'relik.error_report.v1',
        fingerprint: fingerprintOf(report),
        report,
      },
    },
  ],
  authority,
  { now, since: now - 60_000 }
).entries;
const plan = (github: MemoryGitHub, at: number) =>
  planReports(input, github, { now: at, autofix: 'on', authority });
const reservation = { runId: '123456', now };
const expiry = (3 * (70 + 70 + 10) + 30) * 60_000;

test('a skipped matrix reservation carries the run id and expires for a retry', async () => {
  let clock = now;
  const github = new MemoryGitHub([], () => new Date(clock).toISOString());
  const first = await plan(github, now);
  expect(await applyPlan(first, github, 'live', reservation)).toHaveLength(1);
  expect(github.issues[0]?.body).toContain('run=123456');
  expect((await plan(github, now + expiry - 1)).candidates).toHaveLength(0);
  clock = now + expiry + 1;
  const retry = await plan(github, clock);
  expect(retry.candidates).toHaveLength(1);
  await applyPlan(retry, github, 'live', { runId: '123457', now: clock });
  expect(github.issues[0]?.body).toContain('run=123457');
  expect(github.issues[0]?.body).not.toContain('run=123456');
  expect(github.labelEvents.get(github.issues[0]!.number)).toHaveLength(2);
});

test('a label failure after reserving still expires and can be retried', async () => {
  class FailingLabel extends MemoryGitHub {
    override async addLabels(number: number, labels: string[]): Promise<void> {
      if (labels.includes('autofix')) throw new Error('fixture label failure');
      await super.addLabels(number, labels);
    }
  }
  const github = new FailingLabel([], () => new Date(now).toISOString());
  await expect(
    applyPlan(await plan(github, now), github, 'live', reservation)
  ).rejects.toThrow();
  expect(github.issues[0]?.body).toContain('run=123456');
  expect((await plan(github, now + expiry - 1)).candidates).toHaveLength(0);
  expect((await plan(github, now + expiry + 1)).candidates).toHaveLength(1);
});

test('an expired reservation remains blocked by an existing branch or closed unmerged PR', async () => {
  class Existing extends MemoryGitHub {
    override async autofixHistory() {
      return {
        branches: [{ fingerprint: fingerprintOf(report) }],
        pullRequests: [],
      };
    }
  }
  const github = new Existing([], () => new Date(now).toISOString());
  expect((await plan(github, now + expiry + 1)).candidates).toHaveLength(0);
});
