import { expect, test } from 'bun:test';
import { readLogEntries, type LogTransport } from '../src/logging.ts';

const since = '2026-11-20T00:00:00.000Z';
const serverRow = { source: 'server' };
const clientRows = [
  { source: 'viewer' },
  { source: 'mcp' },
  { source: 'viewer' },
];

function sourceOf(body: Record<string, unknown>): 'server' | 'client' {
  const filter = String(body.filter);
  if (filter.includes('jsonPayload.report.source="server"')) return 'server';
  if (
    filter.includes('jsonPayload.report.source="viewer"') &&
    filter.includes('jsonPayload.report.source="mcp"')
  )
    return 'client';
  throw new Error('source-specific filter missing');
}

test('client log overflow retains independent server rows and reports only the retained count', async () => {
  const requests: string[] = [];
  const warnings: number[] = [];
  const transport: LogTransport = {
    async post(body) {
      const source = sourceOf(body);
      requests.push(source);
      return source === 'server'
        ? { entries: [serverRow] }
        : { entries: clientRows, nextPageToken: 'more-private-data' };
    },
  };
  const rows = await readLogEntries(transport, since, {
    maxEntriesPerSource: 2,
    onClientTruncated: (count) => warnings.push(count),
  });
  expect(rows).toEqual([serverRow, ...clientRows.slice(0, 2)]);
  expect(requests).toEqual(['server', 'client']);
  expect(warnings).toEqual([2]);
});

test('client next-page token at its ceiling yields a count-only truncation warning', async () => {
  const warnings: number[] = [];
  let clients = 0;
  const transport: LogTransport = {
    async post(body) {
      if (sourceOf(body) === 'server') return { entries: [serverRow] };
      clients++;
      return { entries: clientRows.slice(0, 2), nextPageToken: 'more' };
    },
  };
  const rows = await readLogEntries(transport, since, {
    maxEntriesPerSource: 2,
    onClientTruncated: (count) => warnings.push(count),
  });
  expect(rows).toHaveLength(3);
  expect(clients).toBe(1);
  expect(warnings).toEqual([2]);
});

test('server log overflow remains fail-closed instead of reporting incomplete server counts', async () => {
  const transport: LogTransport = {
    async post(body) {
      if (sourceOf(body) === 'server')
        return { entries: [serverRow, serverRow, serverRow] };
      return { entries: [] };
    },
  };
  await expect(
    readLogEntries(transport, since, { maxEntriesPerSource: 2 })
  ).rejects.toThrow('server');
});

test('filer dry-run preserves server diagnostics when client logs exceed the ceiling', async () => {
  const cli = new URL('../bin/file-error-reports.ts', import.meta.url).href;
  const format = new URL(
    '../../relic-format/src/error-report.ts',
    import.meta.url
  ).href;
  const code = `
    import { execFileSync } from 'node:child_process';
    const { fingerprintOf } = await import(${JSON.stringify(format)});
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const report = { v: 1, source: 'server', errorClass: 'Error', route: 'GET /health', revision, frames: [], count: 1 };
    const server = {
      timestamp: new Date().toISOString(),
      jsonPayload: { severity: 'ERROR', message: 'relik error report', event: 'relik.error_report.v1', fingerprint: fingerprintOf(report), report }
    };
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://logging.googleapis.com/v2/entries:list') {
        const filter = JSON.parse(String(init.body)).filter;
        if (filter.includes('source="server"')) return Response.json({ entries: [server] });
        if (filter.includes('source="viewer"')) return Response.json({ entries: Array(50001).fill({}) });
        return Response.json({ entries: [...Array(50000).fill({}), server] });
      }
      if (url.startsWith('https://api.github.com/repos/TheBushidoCollective/relik/issues?') && init.method === 'GET')
        return Response.json([]);
      throw new Error('unexpected network request');
    };
    process.argv = ['bun', 'file-error-reports.ts', '--entries', 'cloud', '--mode', 'dry-run', '--autofix', 'off'];
    await import(${JSON.stringify(cli)});
  `;
  const child = Bun.spawn([process.execPath, '-e', code], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GOOGLE_ACCESS_TOKEN: 'fake',
      GITHUB_TOKEN: 'fake',
      GITHUB_STEP_SUMMARY: '',
    },
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exit !== 0) throw new Error(stderr);
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    accepted: 1,
    actions: [{ kind: 'create' }],
  });
  expect(stderr.trim()).toBe('{"clientEntriesTruncatedAt":50000}');
});
