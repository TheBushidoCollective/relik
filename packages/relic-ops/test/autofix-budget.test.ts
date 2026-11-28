import { expect, test } from 'bun:test';
import { fingerprintOf, type ErrorReport } from '@relic/format/error-report';
import { validateEntries } from '../src/entries.ts';
import { MemoryGitHub } from '../src/github.ts';
import { applyPlan, planReports } from '../src/plan.ts';

const reports = (await Bun.file(
  new URL('../fixtures/reports.json', import.meta.url)
).json()) as { viewer: ErrorReport; server: ErrorReport };
const now = Date.parse('2026-11-27T12:00:00Z');
const authority = {
  commitDate: () => new Date(now - 86_400_000).toISOString(),
  serverFrameExists: () => true,
};
const options = { now, autofix: 'on' as const, authority };
function checked(input: Array<{ report: ErrorReport; age?: number }>) {
  return validateEntries(
    input.map(({ report, age = 1000 }) => ({
      timestamp: new Date(now - age).toISOString(),
      severity: 'ERROR',
      jsonPayload: {
        message: 'relik error report',
        event: 'relik.error_report.v1',
        fingerprint: fingerprintOf(report),
        report,
      },
    })),
    authority,
    { now, since: now - 7 * 86_400_000 }
  ).entries;
}
function viewer(
  errorClass: ErrorReport['errorClass'],
  revision: string,
  count = 5
): ErrorReport {
  return { ...reports.viewer, errorClass, revision, count };
}

test('client reports need the occurrence threshold plus two builds or sufficient age', async () => {
  const github = new MemoryGitHub([], () => new Date(now).toISOString());
  const weak = [
    viewer('Error', 'a'.repeat(40), 1),
    viewer('RangeError', 'a'.repeat(40), 5),
  ];
  expect(
    (
      await planReports(
        checked(weak.map((report) => ({ report }))),
        github,
        options
      )
    ).candidates
  ).toHaveLength(0);
  const multi = [
    viewer('Error', 'a'.repeat(40), 5),
    viewer('Error', 'b'.repeat(40), 1),
  ];
  expect(
    (
      await planReports(
        checked(multi.map((report) => ({ report }))),
        github,
        options
      )
    ).candidates
  ).toHaveLength(1);
  expect(
    (
      await planReports(
        checked([
          { report: viewer('Error', 'a'.repeat(40), 5), age: 7 * 3_600_000 },
        ]),
        github,
        options
      )
    ).candidates
  ).toHaveLength(1);
});

test('only one client dispatch consumes a rolling window and later server errors retain capacity', async () => {
  const github = new MemoryGitHub([], () => new Date(now).toISOString());
  const client = (['Error', 'TypeError', 'RangeError'] as const).flatMap(
    (name) => [viewer(name, 'a'.repeat(40)), viewer(name, 'b'.repeat(40), 1)]
  );
  const planned = await planReports(
    checked(client.map((report) => ({ report }))),
    github,
    options
  );
  expect(planned.candidates).toHaveLength(1);
  await applyPlan(planned, github, 'live', { runId: '123456', now });
  const again = await planReports(
    checked([...client, reports.server].map((report) => ({ report }))),
    github,
    options
  );
  expect(again.candidates.map((candidate) => candidate.source)).toEqual([
    'server',
  ]);
});
