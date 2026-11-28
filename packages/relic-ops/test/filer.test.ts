import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type ErrorReport, fingerprintOf } from '@relic/format/error-report';
import {
  GitAuthority,
  type RevisionAuthority,
  validateEntries,
} from '../src/entries.ts';
import {
  DEFAULT_FILER_AUTHOR,
  GitHubRest,
  MemoryGitHub,
} from '../src/github.ts';
import {
  CloudLoggingTransport,
  LOG_VIEW,
  readLogEntries,
} from '../src/logging.ts';
import { applyPlan, planReports as planWithAuthority } from '../src/plan.ts';
import {
  issueTitle,
  parseRegion,
  renderRegion,
  replaceRegion,
} from '../src/render.ts';

const fixtures = (await Bun.file(
  new URL('../fixtures/reports.json', import.meta.url)
).json()) as {
  server: ErrorReport;
  viewer: ErrorReport;
  mcp: ErrorReport;
  injections: string[];
};
const NOW = Date.parse('2026-11-27T12:00:00Z');
const RECENT = new Date(NOW - 1800_000).toISOString();
const REV_DATE = new Date(NOW - 7200_000).toISOString();
const authority: RevisionAuthority = {
  commitDate: () => REV_DATE,
  serverFrameExists: () => true,
};
function planReports(
  entries: Parameters<typeof planWithAuthority>[0],
  github: Parameters<typeof planWithAuthority>[1],
  options: Omit<Parameters<typeof planWithAuthority>[2], 'authority'>
) {
  return planWithAuthority(entries, github, { ...options, authority });
}
const clock = () => new Date(NOW).toISOString();
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'relik-filer-mutants-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function log(report: ErrorReport, timestamp = RECENT): Record<string, unknown> {
  return {
    timestamp,
    severity: 'ERROR',
    jsonPayload: {
      message: 'relik error report',
      event: 'relik.error_report.v1',
      fingerprint: fingerprintOf(report),
      report: structuredClone(report),
    },
  };
}
function accepted(reports: ErrorReport[], auth: RevisionAuthority = authority) {
  return validateEntries(
    reports.map((report) => log(report)),
    auth,
    { now: NOW, since: NOW - 7 * 86_400_000 }
  ).entries;
}
function variants(base: ErrorReport, n: number): ErrorReport[] {
  const names: ErrorReport['errorClass'][] = [
    'Error',
    'TypeError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'EvalError',
    'URIError',
    'AggregateError',
  ];
  return names
    .slice(0, n)
    .map((errorClass) => ({ ...structuredClone(base), errorClass }));
}
async function mutant(
  file: 'entries' | 'render' | 'plan',
  before: string,
  after: string
): Promise<string> {
  const sourcePath = new URL(`../src/${file}.ts`, import.meta.url);
  let source = await readFile(sourcePath, 'utf8');
  assert.ok(source.includes(before), `mutant anchor missing in ${file}`);
  source = source.replace(before, after);
  const formatPath = fileURLToPathForFormat();
  source = source.replaceAll(
    "'@relic/format/error-report'",
    JSON.stringify(formatPath)
  );
  source = source.replaceAll(
    "'./render.ts'",
    JSON.stringify(fileURLToPathForRender())
  );
  source = source.replaceAll(
    "'./entries.ts'",
    JSON.stringify(new URL('../src/entries.ts', import.meta.url).pathname)
  );
  source = source.replaceAll(
    "'./github.ts'",
    JSON.stringify(new URL('../src/github.ts', import.meta.url).pathname)
  );
  const path = join(scratch, `${file}-${crypto.randomUUID()}.ts`);
  await writeFile(path, source);
  return pathToFileURL(path).href;
}
function fileURLToPathForFormat(): string {
  return new URL('../../relic-format/src/error-report.ts', import.meta.url)
    .pathname;
}
function fileURLToPathForRender(): string {
  return new URL('../src/render.ts', import.meta.url).pathname;
}

function assertNoActions(length: number): void {
  assert.equal(length, 0);
}
function assertCounts(server: number, clients: number, fixes: number): void {
  assert.equal(server, 5);
  assert.equal(clients, 5);
  assert.equal(fixes, 3);
}

describe('allowlist and immutable git evidence', () => {
  test('rejects forged text in every string position with no issue actions', async () => {
    const positions = [
      'severity',
      'message',
      'event',
      'fingerprint',
      'source',
      'errorClass',
      'route',
      'revision',
      'file',
    ];
    const forged: unknown[] = [];
    for (const text of fixtures.injections)
      for (const position of positions) {
        const value = log(fixtures.server);
        const payload = value.jsonPayload as Record<string, unknown>;
        const report = payload.report as Record<string, unknown>;
        if (position === 'severity') value.severity = text;
        else if (['message', 'event', 'fingerprint'].includes(position))
          payload[position] = text;
        else if (position === 'file')
          (report.frames as Array<Record<string, unknown>>)[0]!.file = text;
        else report[position] = text;
        forged.push(value);
      }
    const result = validateEntries(forged, authority, {
      now: NOW,
      since: NOW - 7 * 86_400_000,
    });
    assert.equal(result.entries.length, 0);
    assert.equal(
      Object.values(result.dropped).reduce((a, b) => a + b, 0),
      forged.length
    );
    const github = new MemoryGitHub([], clock);
    assertNoActions(
      (await planReports(result.entries, github, { now: NOW, autofix: 'on' }))
        .actions.length
    );
    assert.equal(github.writes, 0);
    // Deliberately remove the message guard and show the same assertion fails.
    const broken = (await import(
      await mutant(
        'entries',
        "p.message !== 'relik error report' ||",
        'false ||'
      )
    )) as typeof import('../src/entries.ts');
    const one = log(fixtures.server);
    (one.jsonPayload as Record<string, unknown>).message =
      fixtures.injections[0];
    const unsafe = broken.validateEntries([one], authority, {
      now: NOW,
      since: NOW - 7 * 86_400_000,
    });
    const unsafePlan = await planReports(unsafe.entries, github, {
      now: NOW,
      autofix: 'off',
    });
    expect(() => assertNoActions(unsafePlan.actions.length)).toThrow();
  });

  test('rejects fingerprint, timestamps, unknown revisions, tags and invalid server frame lines', () => {
    const valid = log(fixtures.server);
    const badFingerprint = structuredClone(valid);
    (badFingerprint.jsonPayload as Record<string, unknown>).fingerprint =
      '0'.repeat(16);
    const badTime = { ...log(fixtures.server), timestamp: 'never' };
    const unknown = validateEntries(
      [log(fixtures.mcp)],
      { ...authority, commitDate: () => null },
      { now: NOW, since: 0 }
    );
    const frame = validateEntries(
      [valid],
      { ...authority, serverFrameExists: () => false },
      { now: NOW, since: 0 }
    );
    const results = validateEntries(
      [
        valid,
        badFingerprint,
        badTime,
        { ...log(fixtures.viewer), timestamp: new Date(NOW + 1).toISOString() },
      ],
      authority,
      { now: NOW, since: 0 }
    );
    assert.equal(results.entries.length, 1);
    assert.equal(results.dropped.fingerprint, 1);
    assert.equal(results.dropped.timestamp, 1);
    assert.equal(results.dropped['outside-window'], 1);
    assert.equal(unknown.dropped.revision, 1);
    assert.equal(frame.dropped.frame, 1);
    let authorityCalls = 0;
    const prefiltered = validateEntries(
      [log(fixtures.server), log(fixtures.mcp)],
      {
        ...authority,
        commitDate: () => {
          authorityCalls++;
          return REV_DATE;
        },
      },
      {
        now: NOW,
        since: 0,
        known: { revisions: new Set(), mcpVersions: new Set() },
      }
    );
    assert.equal(prefiltered.dropped.revision, 2);
    assert.equal(authorityCalls, 0);
    const git = new GitAuthority();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    assert.ok(git.commitDate('server', head));
    assert.equal(git.commitDate('server', '0'.repeat(40)), null);
    assert.equal(git.commitDate('mcp', '9999.9999.9999'), null);
    assert.ok(
      git.serverFrameExists(head, 'packages/relic-server/src/app.ts', 1)
    );
    assert.equal(
      git.serverFrameExists(
        head,
        'packages/relic-server/src/app.ts',
        10_000_000
      ),
      false
    );
    assert.equal(
      git.serverFrameExists(
        head,
        'packages/relic-server/src/no-such-file.ts',
        1
      ),
      false
    );
  });
});

describe('filing and grammar', () => {
  test('renders only the fixed grammar and detects an injected body', async () => {
    const [entry] = accepted([fixtures.server]);
    assert.ok(entry);
    const report = entry.report;
    const data = {
      v: 1 as const,
      fingerprint: entry.fingerprint,
      source: report.source,
      errorClass: report.errorClass,
      route: report.route,
      builds: [{ revision: report.revision, frames: report.frames }],
      count7d: 1,
    };
    const body = renderRegion(data);
    assert.deepEqual(parseRegion(body), data);
    assert.ok(!body.includes('@') && !body.includes('https://'));
    const injected = body.replace(
      'Frames from the newest build:',
      'FORGED TEXT\nFrames from the newest build:'
    );
    assert.equal(parseRegion(injected), null);
    assert.equal(
      parseRegion(
        body.replace(
          'Frames from the newest build:',
          '@jwaldrip\nFrames from the newest build:'
        )
      ),
      null
    );
    assert.equal(
      parseRegion(
        body.replace(
          'Frames from the newest build:',
          'https://evil.example\nFrames from the newest build:'
        )
      ),
      null
    );
    const broken = (await import(
      await mutant('render', 'renderRegion(parsed) === region', 'true')
    )) as typeof import('../src/render.ts');
    expect(() => assert.equal(broken.parseRegion(injected), null)).toThrow();
    assert.ok(issueTitle(data).endsWith(`[${entry.fingerprint}]`));
  });

  test('dry-run writes nothing and the second live run is a no-op', async () => {
    const github = new MemoryGitHub([], clock);
    const entries = accepted([fixtures.server, fixtures.viewer, fixtures.mcp]);
    const plan = await planReports(entries, github, {
      now: NOW,
      autofix: 'on',
    });
    assert.deepEqual(await applyPlan(plan, github, 'dry-run'), []);
    assert.equal(github.writes, 0);
    await applyPlan(plan, github, 'live', { runId: '123456', now: NOW });
    const writes = github.writes;
    assert.equal(github.issues.length, 3);
    assert.ok(
      github.issues.every((issue) => issue.locked && parseRegion(issue.body))
    );
    const second = await planReports(entries, github, {
      now: NOW,
      autofix: 'on',
    });
    assertNoActions(second.actions.length);
    await applyPlan(second, github, 'live');
    assert.equal(github.writes, writes);
    const broken = (await import(
      await mutant('plan', 'if (body !== issue.body)', 'if (true)')
    )) as typeof import('../src/plan.ts');
    const brokenSecond = await broken.planReports(entries, github, {
      now: NOW,
      autofix: 'off',
      authority,
    });
    expect(() => assertNoActions(brokenSecond.actions.length)).toThrow();
  });

  test('ages counts to zero once the last seven-day hit expires', async () => {
    const github = new MemoryGitHub([], clock);
    const entries = accepted([fixtures.server]);
    await applyPlan(
      await planReports(entries, github, { now: NOW, autofix: 'off' }),
      github,
      'live'
    );
    const empty = await planReports([], github, {
      now: NOW + 8 * 86_400_000,
      autofix: 'off',
    });
    assert.equal(
      empty.actions.filter((action) => action.kind === 'update').length,
      1
    );
    await applyPlan(empty, github, 'live');
    assert.equal(parseRegion(github.issues[0]!.body)?.count7d, 0);
    assertNoActions(
      (
        await planReports([], github, {
          now: NOW + 8 * 86_400_000,
          autofix: 'off',
        })
      ).actions.length
    );
    const broken = (await import(
      await mutant(
        'plan',
        'data && data.count7d > 0',
        'false && data && data.count7d > 0'
      )
    )) as typeof import('../src/plan.ts');
    const unsafe = await broken.planReports(
      [],
      new MemoryGitHub(
        [
          {
            ...github.issues[0]!,
            body: renderRegion({
              ...parseRegion(github.issues[0]!.body)!,
              count7d: 1,
            }),
          },
        ],
        clock
      ),
      { now: NOW + 8 * 86_400_000, autofix: 'off', authority }
    );
    expect(() => assert.equal(unsafe.actions.length, 1)).toThrow();
  });

  test('enforces independent rolling caps and prefers server autofixes despite a client flood', async () => {
    const github = new MemoryGitHub([], clock);
    const entries = accepted([
      ...variants(fixtures.viewer, 8),
      ...variants(fixtures.server, 8),
    ]);
    const plan = await planReports(entries, github, {
      now: NOW,
      autofix: 'on',
    });
    const count = (source: string) =>
      plan.actions.filter(
        (action) =>
          action.kind === 'create' && action.labels.includes(`source:${source}`)
      ).length;
    assertCounts(
      count('server'),
      count('viewer') + count('mcp'),
      plan.candidates.length
    );
    assert.ok(
      plan.candidates.every((candidate) => candidate.source === 'server')
    );
    const broken = (await import(
      await mutant(
        'plan',
        'const MAX_PER_SOURCE = 5;',
        'const MAX_PER_SOURCE = 50;'
      )
    )) as typeof import('../src/plan.ts');
    const unsafe = await broken.planReports(entries, github, {
      now: NOW,
      autofix: 'on',
      authority,
    });
    const unsafeCount = (source: string) =>
      unsafe.actions.filter(
        (action) =>
          action.kind === 'create' && action.labels.includes(`source:${source}`)
      ).length;
    expect(() =>
      assertCounts(
        unsafeCount('server'),
        unsafeCount('viewer') + unsafeCount('mcp'),
        unsafe.candidates.length
      )
    ).toThrow();
    const brokenAutofix = (await import(
      await mutant('plan', 'const MAX_AUTOFIX = 3;', 'const MAX_AUTOFIX = 30;')
    )) as typeof import('../src/plan.ts');
    const unsafeAutofix = await brokenAutofix.planReports(entries, github, {
      now: NOW,
      autofix: 'on',
      authority,
    });
    expect(() => assert.equal(unsafeAutofix.candidates.length, 3)).toThrow();
    await applyPlan(plan, github, 'live', { runId: '123456', now: NOW });
    const existing = new Set(
      github.issues.map(
        (issue) => issue.title.match(/\[([0-9a-f]{16})\]$/)?.[1]
      )
    );
    const fresh = variants(fixtures.server, 8).filter(
      (report) => !existing.has(fingerprintOf(report))
    );
    assert.equal(fresh.length, 3);
    assert.equal(
      (
        await planReports(accepted(fresh), github, { now: NOW, autofix: 'off' })
      ).actions.filter((action) => action.kind === 'create').length,
      0
    );
    assert.equal(
      (
        await planReports(accepted(fresh), github, {
          now: NOW + 24 * 86_400_000 + 1,
          autofix: 'off',
        })
      ).actions.filter((action) => action.kind === 'create').length,
      3
    );
    github.labelEvents.set(1, [
      new Date(NOW - 1000).toISOString(),
      new Date(NOW - 2000).toISOString(),
      new Date(NOW - 3000).toISOString(),
    ]);
    assert.equal(
      (await planReports(entries, github, { now: NOW, autofix: 'on' }))
        .candidates.length,
      0
    );
  });

  test('preserves human text outside markers during an update', async () => {
    const entry = accepted([fixtures.server])[0]!;
    const data = {
      v: 1 as const,
      fingerprint: entry.fingerprint,
      source: entry.report.source,
      errorClass: entry.report.errorClass,
      route: entry.report.route,
      builds: [
        { revision: entry.report.revision, frames: entry.report.frames },
      ],
      count7d: 1,
    };
    const old = `before\n${renderRegion(data)}\nafter`;
    const changed = { ...data, count7d: 2 };
    const updated = replaceRegion(old, changed);
    const assertPreserved = (value: string) => {
      assert.ok(value.startsWith('before\n'));
      assert.ok(value.endsWith('\nafter'));
      assert.deepEqual(parseRegion(value), changed);
    };
    assertPreserved(updated);
    const github = new MemoryGitHub(
      [
        {
          number: 1,
          author: DEFAULT_FILER_AUTHOR,
          title: issueTitle(data),
          body: old,
          state: 'open',
          createdAt: clock(),
          closedAt: null,
          labels: ['error-report', 'source:server'],
          locked: true,
        },
      ],
      clock
    );
    const plan = await planReports([entry, entry], github, {
      now: NOW,
      autofix: 'off',
    });
    await applyPlan(plan, github, 'live');
    assertPreserved(github.issues[0]!.body);
    const broken = (await import(
      await mutant('render', 'body.slice(0, begin)', "''")
    )) as typeof import('../src/render.ts');
    expect(() => assertPreserved(broken.replaceRegion(old, changed))).toThrow();
  });

  test('marks closed issues only for hits after close on builds committed after close', async () => {
    const github = new MemoryGitHub([], clock);
    const entries = accepted([fixtures.server]);
    await applyPlan(
      await planReports(entries, github, { now: NOW, autofix: 'off' }),
      github,
      'live'
    );
    const issue = github.issues[0]!;
    issue.state = 'closed';
    issue.closedAt = new Date(NOW - 3600_000).toISOString();
    const oldBuild = await planReports(entries, github, {
      now: NOW,
      autofix: 'off',
    });
    const hasSeenLabel = (plan: typeof oldBuild) =>
      plan.actions.some(
        (action) =>
          action.kind === 'labels' && action.labels.includes('seen-after-close')
      );
    assert.equal(hasSeenLabel(oldBuild), false);
    const newBuild = entries.map((entry) => ({
      ...entry,
      committedAt: new Date(NOW - 2700_000).toISOString(),
    }));
    assert.equal(
      hasSeenLabel(
        await planReports(newBuild, github, { now: NOW, autofix: 'off' })
      ),
      true
    );
    const preClose = newBuild.map((entry) => ({
      ...entry,
      timestamp: new Date(NOW - 4000_000).toISOString(),
    }));
    assert.equal(
      hasSeenLabel(
        await planReports(preClose, github, { now: NOW, autofix: 'off' })
      ),
      false
    );
    const broken = (await import(
      await mutant('plan', 'Date.parse(entry.committedAt) > closedAt', 'true')
    )) as typeof import('../src/plan.ts');
    const unsafe = await broken.planReports(entries, github, {
      now: NOW,
      autofix: 'off',
      authority,
    });
    expect(() => assert.equal(hasSeenLabel(unsafe), false)).toThrow();
  });
});

test('discovers a report even when its title and labels were changed', async () => {
  const memory = new MemoryGitHub([], clock);
  const entries = accepted([fixtures.server]);
  await applyPlan(
    await planReports(entries, memory, { now: NOW, autofix: 'off' }),
    memory,
    'live'
  );
  const original = memory.issues[0]!;
  const response = {
    number: original.number,
    user: original.author,
    title: 'Renamed by an owner',
    body: original.body,
    state: 'open',
    created_at: original.createdAt,
    closed_at: null,
    labels: [],
    locked: true,
  };
  const request = async (_url: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.method === 'GET');
    return Response.json([response]);
  };
  const github = new GitHubRest('fake-token', request);
  assert.equal((await github.listIssues()).length, 1);
  const plan = await planReports(entries, github, { now: NOW, autofix: 'off' });
  assert.equal(plan.isolated.invalid, 1);
  assert.equal(plan.actions.length, 0);
});

test('offline fixture CLI prints its dry-run plan and refuses live or cloud', async () => {
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const report = { ...fixtures.server, revision };
  const path = join(scratch, 'entries.json');
  await writeFile(
    path,
    JSON.stringify([log(report, new Date().toISOString())])
  );
  const command = new URL('../bin/file-error-reports.ts', import.meta.url)
    .pathname;
  const env = {
    ...process.env,
    GITHUB_TOKEN: '',
    GOOGLE_ACCESS_TOKEN: '',
    GITHUB_STEP_SUMMARY: '',
  };
  const run = async (mode: string, entries: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        command,
        '--entries',
        entries,
        '--mode',
        mode,
        '--autofix',
        'off',
        '--github-fixture',
        'empty',
      ],
      { stdout: 'pipe', stderr: 'pipe', env }
    );
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };
  const result = await run('dry-run', path);
  assert.equal(result.exit, 0, result.stderr);
  const plan = JSON.parse(result.stdout) as {
    accepted: number;
    actions: Array<{ kind: string }>;
  };
  assert.equal(plan.accepted, 1);
  assert.deepEqual(
    plan.actions.map((action) => action.kind),
    ['create']
  );
  const live = await run('live', path);
  assert.notEqual(live.exit, 0);
  assert.match(
    live.stderr,
    /GitHub fixture requires local entries and dry-run mode/
  );
  const cloud = await run('dry-run', 'cloud');
  assert.notEqual(cloud.exit, 0);
  assert.match(
    cloud.stderr,
    /GitHub fixture requires local entries and dry-run mode/
  );
});

describe('logging transport', () => {
  test('paginates the view, omits quota headers and rejects non-200 responses', async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Headers[] = [];
    const request = async (_url: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      headers.push(new Headers(init?.headers));
      return Response.json(
        bodies.length === 1
          ? { entries: [log(fixtures.server)], nextPageToken: 'next' }
          : bodies.length === 2
            ? { entries: [] }
            : { entries: [log(fixtures.viewer)] }
      );
    };
    const values = await readLogEntries(
      new CloudLoggingTransport('fake-token', request),
      new Date(NOW - 86_400_000).toISOString()
    );
    assert.equal(values.length, 2);
    assert.deepEqual(bodies[0]?.resourceNames, [LOG_VIEW]);
    assert.equal(bodies[1]?.pageToken, 'next');
    assert.equal(bodies.length, 3);
    assert.match(String(bodies[0]?.filter), /source="server"/);
    assert.match(String(bodies[2]?.filter), /source="viewer"/);
    assert.equal(headers[0]?.get('x-goog-user-project'), null);
    assert.equal(headers[0]?.get('authorization'), 'Bearer fake-token');
    const failure = async () => new Response('denied', { status: 403 });
    await expect(
      readLogEntries(
        new CloudLoggingTransport('fake-token', failure),
        new Date(NOW).toISOString()
      )
    ).rejects.toThrow('HTTP 403');
    await expect(
      readLogEntries(
        { post: async () => ({ entries: [], nextPageToken: 'loop' }) },
        new Date(NOW).toISOString()
      )
    ).rejects.toThrow('pagination incomplete');
  });
});
