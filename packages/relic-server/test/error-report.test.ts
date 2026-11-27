import { describe, expect, spyOn, test } from 'bun:test';
import { generateRelicId } from '@relic/format';
import {
  ERROR_CLASSES,
  type ErrorReport,
  parseLoggedReport,
  SERVER_ROUTES,
  VIEWER_ROUTES,
} from '@relic/format/error-report';
import { createApp } from '../src/app.ts';
import { memoryAssets } from '../src/assets.ts';
import { assertConfig, DEFAULT_CONFIG } from '../src/config.ts';
import { serverRouteOf } from '../src/error-report-routes.ts';
import { createErrorReporter } from '../src/error-report.ts';
import { startRelicServer } from '../src/index.ts';
import { MemoryStore } from '../src/store.ts';

const REVISION = 'a'.repeat(40);
const ID = generateRelicId();
const CANARIES = [
  ID,
  'jane.doe@example.com',
  '/Users/jane/Secret Plans.pdf',
  `#${'q'.repeat(43)}`,
];
const QUERY = CANARIES.map(encodeURIComponent).join('&');

function noCanaries(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of CANARIES) expect(text).not.toContain(canary);
}

function viewer(): ErrorReport {
  return {
    v: 1,
    source: 'viewer',
    errorClass: 'TypeError',
    route: 'public-open',
    revision: REVISION,
    frames: [{ file: 'assets/viewer.js', line: 7, column: 3 }],
    count: 1,
  };
}

function mcp(): ErrorReport {
  return {
    v: 1,
    source: 'mcp',
    errorClass: 'Error',
    route: 'process',
    revision: '1.2.3',
    frames: [{ file: 'dist/relic-mcp.js', line: 4, column: 1 }],
    count: 1,
  };
}

function setup(config: Parameters<typeof createApp>[0] = {}) {
  const lines: string[] = [];
  let current = 0;
  const reporter = createErrorReporter({
    revision: REVISION,
    now: () => current,
    emit: (line) => lines.push(line),
  });
  const app = createApp({
    now: () => current,
    config: {
      revision: REVISION,
      errorReportRateLimit: { limit: 1000, windowSeconds: 3600 },
      errorReportGlobalRateLimit: { limit: 2000, windowSeconds: 3600 },
    },
    assets: memoryAssets({
      'viewer.js': 'viewer',
      'chunk-abcdefgh.js': 'chunk',
    }),
    errorReporter: reporter,
    ...config,
  });
  return {
    app,
    lines,
    reporter,
    clock: (time: number) => {
      current = time;
    },
  };
}

function post(
  body: unknown,
  extra: { type?: string; ip?: string } = {}
): Request {
  return new Request(`https://relic.example/api/error-reports?${QUERY}`, {
    method: 'POST',
    headers: {
      'content-type': extra.type ?? 'application/json',
      'x-real-ip': extra.ip ?? '198.51.100.1',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function parsed(lines: string[]): Array<{
  severity: string;
  message: string;
  event: string;
  fingerprint: string;
  report: ErrorReport;
}> {
  return lines.map((line) => JSON.parse(line));
}

describe('uncaught server boundary', () => {
  test('scrubs throwing asset and store errors from responses and logs', async () => {
    const error = new Error(CANARIES.join(' '));
    error.stack = `Error: ${CANARIES.join(' ')}\n    at safe (/srv/packages/relic-server/src/app.ts:23:4)\n    at leak (${CANARIES[2]}:3:4)`;
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const shell = setup({
        assets: {
          get: async () => {
            throw error;
          },
        },
      });
      const first = await shell.app.fetch(
        new Request(`https://relic.example/${ID}?${QUERY}`)
      );
      const firstText = await first.text();
      expect(first.status).toBe(500);
      expect(first.headers.get('content-type')).toBe('text/plain');
      expect(firstText).toBe('Something went wrong!');
      expect(shell.lines).toHaveLength(1);
      const firstLog = parsed(shell.lines)[0]!;
      expect(Object.keys(firstLog)).toEqual([
        'severity',
        'message',
        'event',
        'fingerprint',
        'report',
      ]);
      expect(firstLog.severity).toBe('ERROR');
      expect(firstLog.message).toBe('relik error report');
      expect(firstLog.event).toBe('relik.error_report.v1');
      expect(firstLog.fingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(parseLoggedReport(firstLog.report)).toEqual(firstLog.report);
      expect(firstLog.report.route).toBe('GET /:id');
      noCanaries(firstText);
      noCanaries(shell.lines);
      noCanaries([...first.headers]);

      class ThrowingStore extends MemoryStore {
        override async getTombstone(): Promise<never> {
          throw error;
        }
      }
      const server = setup({ store: new ThrowingStore() });
      const second = await server.app.fetch(
        new Request(`https://relic.example/api/relics/${ID}/mint?${QUERY}`, {
          method: 'POST',
        })
      );
      const secondText = await second.text();
      expect(second.status).toBe(500);
      expect(second.headers.get('content-type')).toBe('text/plain');
      expect(secondText).toBe('Something went wrong!');
      expect(server.lines).toHaveLength(1);
      const secondLog = parsed(server.lines)[0]!;
      expect(Object.keys(secondLog)).toEqual([
        'severity',
        'message',
        'event',
        'fingerprint',
        'report',
      ]);
      expect(parseLoggedReport(secondLog.report)).toEqual(secondLog.report);
      expect(secondLog.report.route).toBe('POST /api/relics/:id/mint');
      noCanaries(secondText);
      noCanaries([...second.headers]);
      noCanaries(server.lines);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('prints uncaught errors only in development without a revision', async () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('local debugging');
    try {
      const app = createApp({
        assets: {
          get: async () => {
            throw error;
          },
        },
      });
      const response = await app.fetch(
        new Request(`https://relic.example/${ID}`)
      );
      expect(response.status).toBe(500);
      expect(spy).toHaveBeenCalledWith(error);
    } finally {
      spy.mockRestore();
    }
  });

  test('wraps presence relay exceptions without logging their input', async () => {
    const error = new Error(CANARIES.join(' '));
    const lines: string[] = [];
    const reporter = createErrorReporter({
      revision: REVISION,
      emit: (line) => lines.push(line),
    });
    const spy = spyOn(crypto, 'getRandomValues').mockImplementation(() => {
      throw error;
    });
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});
    const server = startRelicServer({
      port: 0,
      role: 'presence',
      config: { ...DEFAULT_CONFIG, revision: REVISION },
      errorReporter: reporter,
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/presence/${'A'.repeat(22)}?${QUERY}`,
        { headers: { origin: DEFAULT_CONFIG.serviceOrigin } }
      );
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(response.headers.get('content-type')).toBe('text/plain');
      expect(text).toBe('Something went wrong!');
      expect(lines).toHaveLength(1);
      expect(parseLoggedReport(parsed(lines)[0]!.report)?.route).toBe(
        'GET /api/presence/:roomId'
      );
      noCanaries(text);
      noCanaries(lines);
      expect(consoleSpy).not.toHaveBeenCalled();
    } finally {
      server.stop(true);
      spy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe('error report endpoint', () => {
  test('accepts viewer and mcp reports without an Origin and logs only the schema', async () => {
    const { app, lines } = setup();
    for (const report of [viewer(), mcp()]) {
      const response = await app.fetch(post(report));
      expect(response.status).toBe(204);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe('');
    }
    expect(lines).toHaveLength(2);
    for (const line of parsed(lines)) {
      expect(Object.keys(line)).toEqual([
        'severity',
        'message',
        'event',
        'fingerprint',
        'report',
      ]);
      expect(parseLoggedReport(line.report)).toEqual(line.report);
    }
    noCanaries(lines);
  });

  test('refuses canaries in every attacker-controlled report position without echoing or logging them', async () => {
    const { app, lines } = setup();
    const spy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const invalid: unknown[] = [];
      for (const canary of CANARIES) {
        for (const key of [
          'v',
          'source',
          'errorClass',
          'route',
          'revision',
          'frames',
          'count',
        ]) {
          invalid.push({ ...viewer(), [key]: canary });
        }
        for (const key of ['file', 'line', 'column', 'extra']) {
          invalid.push({
            ...viewer(),
            frames: [
              { file: 'assets/viewer.js', line: 1, column: 1, [key]: canary },
            ],
          });
        }
        for (const key of ['message', 'url', 'stack', canary])
          invalid.push({ ...viewer(), [key]: canary });
      }
      invalid.push(
        { ...viewer(), source: 'server' },
        { ...viewer(), count: 2 },
        { ...viewer(), frames: Array(9).fill(viewer().frames[0]) }
      );
      invalid.push(' '.repeat(4097), 'é'.repeat(2049), '{invalid json');
      for (const input of invalid) {
        const response = await app.fetch(post(input));
        const text = await response.text();
        expect(response.status).toBe(400);
        expect(JSON.parse(text).code).toBe('invalid_error_report');
        noCanaries(text);
        noCanaries([...response.headers]);
      }
      const wrongType = await app.fetch(post(viewer(), { type: 'text/plain' }));
      expect(wrongType.status).toBe(400);
      noCanaries(await wrongType.text());
      expect(lines).toHaveLength(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  test('rejects unknown viewer revisions and unserved viewer chunk names', async () => {
    const { app, lines } = setup();
    const forgedRevision = await app.fetch(
      post({ ...viewer(), revision: 'b'.repeat(40) })
    );
    expect(forgedRevision.status).toBe(400);
    const forgedChunk = await app.fetch(
      post({
        ...viewer(),
        frames: [{ file: 'assets/chunk-zzzzzzzz.js', line: 1, column: 0 }],
      })
    );
    expect(forgedChunk.status).toBe(400);
    const actualChunk = await app.fetch(
      post({
        ...viewer(),
        frames: [{ file: 'assets/chunk-abcdefgh.js', line: 1, column: 0 }],
      })
    );
    expect(actualChunk.status).toBe(204);
    const generatedScript = await app.fetch(
      post({
        ...viewer(),
        frames: [{ file: 'assets/register-sw.js', line: 1, column: 0 }],
      })
    );
    expect(generatedScript.status).toBe(204);
    expect(lines).toHaveLength(2);
    noCanaries(lines);
  });

  test('rejects other methods and enforces the 30-per-IP window', async () => {
    const app = createApp({ config: { revision: REVISION } });
    const wrongMethod = await app.fetch(
      new Request('https://relic.example/api/error-reports', { method: 'GET' })
    );
    expect(wrongMethod.status).toBe(405);
    for (let i = 0; i < 30; i += 1)
      expect((await app.fetch(post('no'))).status).toBe(400);
    const limited = await app.fetch(post('no'));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({
      code: 'error_report_rate_limited',
    });
  });

  test('enforces the 600-per-instance window across distinct IPs', async () => {
    const app = createApp({
      config: { revision: REVISION, trustedProxyHops: 0 },
    });
    for (let i = 0; i < 600; i += 1) {
      const response = await app.fetch(
        post('no', { ip: `198.51.${Math.floor(i / 250)}.${(i % 250) + 1}` })
      );
      expect(response.status).toBe(400);
    }
    const response = await app.fetch(post('no', { ip: '203.0.113.1' }));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await response.json()).toMatchObject({
      code: 'error_report_rate_limited',
    });
  });
});

describe('aggregation', () => {
  test('emits first occurrences, batches later hits after 600 seconds and flushes other due fingerprints', () => {
    const { reporter, lines, clock } = setup();
    reporter.client(viewer());
    reporter.client(mcp());
    reporter.client(viewer());
    reporter.client(mcp());
    clock(599_999);
    reporter.client(viewer());
    expect(parsed(lines).map((line) => line.report.count)).toEqual([1, 1]);
    clock(600_000);
    reporter.client(viewer());
    expect(parsed(lines).map((line) => line.report.count)).toEqual([
      1, 1, 3, 1,
    ]);
    clock(1_200_000);
    reporter.client(viewer());
    expect(parsed(lines).map((line) => line.report.count)).toEqual([
      1, 1, 3, 1, 1,
    ]);
  });

  test('caps server and client fingerprints separately and expires client entries after 24 hours', () => {
    const { reporter, lines, clock } = setup();
    const clientReports: ErrorReport[] = [];
    for (const route of VIEWER_ROUTES) {
      for (const errorClass of ERROR_CLASSES) {
        clientReports.push({ ...viewer(), route, errorClass });
        if (clientReports.length === 201) break;
      }
      if (clientReports.length === 201) break;
    }
    expect(clientReports).toHaveLength(201);
    for (const item of clientReports) reporter.client(item);
    expect(lines).toHaveLength(200);
    for (let i = 0; i < 201; i += 1) {
      const err = new Error('');
      err.stack = `Error\n    at safe (/srv/packages/relic-server/src/file${i}.ts:1:0)`;
      reporter.server(err, 'GET', '/health');
    }
    expect(lines).toHaveLength(400);
    clock(86_400_000);
    reporter.client(clientReports[200]!);
    expect(lines).toHaveLength(401);
    noCanaries(lines);
  });

  test('never propagates a hostile exception, clock or sink failure', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(CANARIES.join(' '));
        },
      }
    );
    const clockFailure = createErrorReporter({
      revision: REVISION,
      now: () => {
        throw hostile;
      },
    });
    const sinkFailure = createErrorReporter({
      revision: REVISION,
      emit: () => {
        throw hostile;
      },
    });
    expect(() => clockFailure.server(hostile, 'GET', `/${ID}`)).not.toThrow();
    expect(() => sinkFailure.server(hostile, 'GET', `/${ID}`)).not.toThrow();
    expect(() => sinkFailure.client(viewer())).not.toThrow();
  });
});

describe('route and revision contracts', () => {
  test('maps a sample for every catalog template and never returns path data', () => {
    for (const route of SERVER_ROUTES) {
      if (route === 'other') continue;
      const [method, template] = route.split(' ');
      const sample = template!
        .replace(/:[a-zA-Z]+/g, 'sample')
        .replace('*', 'sample.js');
      expect(serverRouteOf(method!, sample)).toBe(route);
    }
    expect(serverRouteOf('POST', `/api/relics/${ID}/mint/extra`)).toBe(
      'POST /api/relics/:id/mint'
    );
    expect(serverRouteOf('POST', `/api/challenge/${ID}`)).toBe(
      'POST /api/challenge'
    );
    expect(serverRouteOf('GET', `/policy/${ID}`)).toBe('GET /policy');
    expect(serverRouteOf('POST', `/api/relics/${ID}/share/extra`)).toBe(
      'other'
    );
    for (const method of ['GET', 'POST', 'DELETE', 'PATCH', 'strange']) {
      for (const canary of CANARIES) {
        for (const path of [
          `/${canary}`,
          `/api/relics/${canary}/mint`,
          `/api/unknown/${canary}`,
        ]) {
          const output = serverRouteOf(method, path);
          expect(SERVER_ROUTES).toContain(output);
          noCanaries(output);
        }
      }
    }
  });

  test('includes revision on shell roots only when configured', async () => {
    const { app } = setup();
    const response = await app.fetch(
      new Request(`https://relic.example/${ID}`)
    );
    expect(await response.text()).toContain(`data-revision="${REVISION}"`);
    const local = createApp();
    expect(
      await local
        .fetch(new Request(`https://relic.example/${ID}`))
        .then((res) => res.text())
    ).not.toContain('data-revision=');
    for (const invalid of [
      '',
      'a'.repeat(39),
      'A'.repeat(40),
      `${REVISION}\n`,
    ]) {
      expect(() =>
        assertConfig({ ...DEFAULT_CONFIG, revision: invalid })
      ).toThrow();
    }
  });

  test('refuses to boot production without RELIC_REVISION', () => {
    const proc = Bun.spawnSync(
      [process.execPath, 'run', 'packages/relic-server/src/index.ts'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'production',
          RELIC_ROLE: 'presence',
          RELIC_REVISION: '',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain(
      'RELIC_REVISION is required in production'
    );
  });
});
