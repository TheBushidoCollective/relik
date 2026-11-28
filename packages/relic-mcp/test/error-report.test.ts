import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  spyOn,
  test,
} from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateRelicId } from '@relic/format';
import { MCP_ROUTES, parseClientReport } from '@relic/format/error-report';
import {
  mcpErrorReportsEnabled as sourceReportsEnabled,
  reportMcpError as sourceReport,
} from '../src/error-report.ts';
import type { FileReader, PublishDeps } from '../src/publish.ts';
import type { JsonRpcResponse } from '../src/server.ts';
import type * as Reporter from '../src/error-report.ts';
import type * as Fixture from './error-report-fixture.ts';

type ReporterModule = typeof Reporter;
type Captured = { url: string; init: RequestInit };

const canaries = [
  generateRelicId(),
  'jane.doe@example.com',
  '/Users/jane/Secret Plans.pdf',
  `#${'A'.repeat(43)}`,
];
const secret = canaries.join(' ');
const originalOptIn = process.env['RELIC_ERROR_REPORTS'];
const originalReleaseBuild = process.env['RELIC_RELEASE_BUILD'];
const originalVersion = process.env['RELIC_MCP_VERSION'];
const reporterPath = new URL('../src/error-report.ts', import.meta.url)
  .pathname;
const fixturePath = new URL('./error-report-fixture.ts', import.meta.url)
  .pathname;
const entryPath = new URL('../src/index.ts', import.meta.url).pathname;
let temp: string;
let fixture: typeof Fixture;
let devReporter: ReporterModule;
let releaseFixtureUrl: string;
let releaseEntryUrl: string;

beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'relic-error-report-tests-'));
  const common = {
    target: 'node' as const,
    format: 'esm' as const,
    define: {
      'process.env.RELIC_MCP_VERSION': JSON.stringify('1.2.3'),
      'process.env.RELIC_MCP_COVER_DIR': JSON.stringify('./cover/'),
      __RELIC_PROGRAM_ASSET_BASE__: JSON.stringify('./program/'),
    },
  };
  const releaseDir = join(temp, 'release');
  const release = await Bun.build({
    ...common,
    entrypoints: [fixturePath, entryPath],
    outdir: releaseDir,
    splitting: true,
    define: { ...common.define, __RELIC_RELEASE_BUILD__: 'true' },
  });
  if (!release.success) throw new Error(release.logs.join('\n'));
  const devDir = join(temp, 'dev');
  const dev = await Bun.build({
    ...common,
    entrypoints: [reporterPath],
    outdir: devDir,
    define: { ...common.define, __RELIC_RELEASE_BUILD__: 'false' },
  });
  if (!dev.success) throw new Error(dev.logs.join('\n'));
  const fixtureOutput = release.outputs.find((file) =>
    file.path.endsWith('/error-report-fixture.js')
  );
  const entryOutput = release.outputs.find((file) =>
    file.path.endsWith('/index.js')
  );
  const devOutput = dev.outputs[0];
  if (
    fixtureOutput === undefined ||
    entryOutput === undefined ||
    devOutput === undefined
  )
    throw new Error('bundle outputs missing');
  releaseFixtureUrl = pathToFileURL(fixtureOutput.path).href;
  releaseEntryUrl = pathToFileURL(entryOutput.path).href;
  // The generated modules intentionally exercise the bundle boundary.
  fixture = await import(releaseFixtureUrl);
  devReporter = await import(pathToFileURL(devOutput.path).href);
});

afterAll(async () => {
  if (temp !== undefined) await rm(temp, { recursive: true, force: true });
});

afterEach(() => {
  if (originalOptIn === undefined) delete process.env['RELIC_ERROR_REPORTS'];
  else process.env['RELIC_ERROR_REPORTS'] = originalOptIn;
  if (originalReleaseBuild === undefined)
    delete process.env['RELIC_RELEASE_BUILD'];
  else process.env['RELIC_RELEASE_BUILD'] = originalReleaseBuild;
  if (originalVersion === undefined) delete process.env['RELIC_MCP_VERSION'];
  else process.env['RELIC_MCP_VERSION'] = originalVersion;
});

function noCanaries(value: unknown): void {
  const text = JSON.stringify(value);
  for (const canary of canaries) expect(text).not.toContain(canary);
}

function canaryError(): Error {
  const error = new TypeError(secret);
  error.stack = `TypeError: ${secret}\n    at ${secret} (/Users/jane/Secret Plans.pdf:11:2)\n    at ${secret} (/private/${secret}/relic-mcp/dist/relic-mcp.js:42:3)`;
  return error;
}

function dependencies(thrown: unknown, calls: Captured[]): PublishDeps {
  const files: FileReader = {
    resolve() {
      throw thrown;
    },
    basename: (path) => path,
    async stat() {
      return { kind: 'file', size: 1 };
    },
    async read() {
      return new Uint8Array();
    },
    async openBundleRoot() {
      throw new Error('unexpected');
    },
  };
  return {
    serviceOrigin: 'https://relic.example',
    relicOrigin: 'https://relic.example',
    files,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return new Response(null, { status: 204 });
    }) as typeof globalThis.fetch,
    upload: async () => ({ status: 200 }),
    clientName: 'test',
    renderCover: async () => ({
      status: 'skipped',
      reason: 'browser_disabled',
      detail: 'test',
    }),
  };
}

function request(name: string) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: { name, arguments: { path: secret } },
  };
}

describe('MCP error reports', () => {
  test('requires exactly 1 and a release-stamped bundle', async () => {
    const calls: Captured[] = [];
    const deps = dependencies(canaryError(), calls);
    delete process.env['RELIC_ERROR_REPORTS'];
    await fixture.handleMessage(request('relic_publish'), deps);
    process.env['RELIC_ERROR_REPORTS'] = 'true';
    await fixture.handleMessage(request('relic_publish'), deps);
    process.env['RELIC_ERROR_REPORTS'] = '1';
    process.env['RELIC_RELEASE_BUILD'] = '1';
    process.env['RELIC_MCP_VERSION'] = '1.2.3';
    await sourceReport(canaryError(), 'process', { fetch: deps.fetch });
    await devReporter.reportMcpError(canaryError(), 'process', {
      fetch: deps.fetch,
    });
    expect(sourceReportsEnabled()).toBe(false);
    expect(devReporter.mcpErrorReportsEnabled()).toBe(false);
    expect(calls).toEqual([]);
    delete process.env['RELIC_ERROR_REPORTS'];
    const description = await fixture.handleMessage(
      request('relic_describe_client'),
      deps
    );
    expect(description?.result).toMatchObject({
      structuredContent: { error_reports: 'off' },
    });
  });

  test('reports unexpected tool failures once without canaries or stray output', async () => {
    process.env['RELIC_ERROR_REPORTS'] = '1';
    const calls: Captured[] = [];
    const deps = dependencies(canaryError(), calls);
    const stdout = spyOn(process.stdout, 'write').mockImplementation(
      () => true
    );
    const stderr = spyOn(process.stderr, 'write').mockImplementation(
      () => true
    );
    const timeout = spyOn(AbortSignal, 'timeout');
    let response: JsonRpcResponse | undefined;
    try {
      response = await fixture.handleMessage(request('relic_publish'), deps);
      await fixture.handleMessage(request('relic_publish'), deps);
      await fixture.handleMessage(request('relic_lookup_source'), deps);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
      expect(timeout).toHaveBeenCalledWith(2000);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      timeout.mockRestore();
    }
    expect(calls).toHaveLength(2);
    const call = calls[0];
    if (call === undefined) throw new Error('missing report');
    expect(call.url).toBe('https://relic.example/api/error-reports');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    const report = JSON.parse(String(call.init.body));
    expect(parseClientReport(report)).toEqual({
      v: 1,
      source: 'mcp',
      errorClass: 'TypeError',
      route: 'relic_publish',
      revision: '1.2.3',
      frames: [{ file: 'dist/relic-mcp.js', line: 42, column: 3 }],
      count: 1,
    });
    const second = calls[1];
    if (second === undefined) throw new Error('missing second report');
    expect(parseClientReport(JSON.parse(String(second.init.body)))?.route).toBe(
      'relic_lookup_source'
    );
    for (const sent of calls) noCanaries(sent);
    expect(response?.result).toMatchObject({
      content: [
        { type: 'text', text: `the call failed: TypeError: ${secret}` },
      ],
      structuredContent: { code: 'unknown' },
      isError: true,
    });
    const description = await fixture.handleMessage(
      request('relic_describe_client'),
      deps
    );
    expect(description?.result).toMatchObject({
      structuredContent: { error_reports: 'on' },
    });
  });

  test('expected tool refusals never report', async () => {
    process.env['RELIC_ERROR_REPORTS'] = '1';
    for (const error of [
      new fixture.PublishError('source_not_found', 'not found'),
      new fixture.FolderReadError('not_found', 'not found'),
      new fixture.ServerRefusal('relic_removed', 410, {}),
    ]) {
      const calls: Captured[] = [];
      const response = await fixture.handleMessage(
        request('relic_publish'),
        dependencies(error, calls)
      );
      expect(response?.result).toMatchObject({ isError: true });
      expect(calls).toEqual([]);
    }
  });

  test('the registered tool names match the report routes', async () => {
    const response = await fixture.handleMessage(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      dependencies(new Error(), [])
    );
    const result = response?.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      MCP_ROUTES.filter((route) => route !== 'process').sort()
    );
  });

  test('rejects invalid routes and tolerates throwing getters', async () => {
    process.env['RELIC_ERROR_REPORTS'] = '1';
    const calls: Captured[] = [];
    const options = {
      serviceOrigin: 'https://relic.example',
      fetch: dependencies(new Error(), calls).fetch,
    };
    await fixture.reportMcpError(canaryError(), secret, options);
    await fixture.reportMcpError(
      {
        get stack() {
          throw new Error(secret);
        },
      },
      'process',
      options
    );
    expect(calls).toHaveLength(0);
  });

  test('failed sends are swallowed without retries', async () => {
    process.env['RELIC_ERROR_REPORTS'] = '1';
    let count = 0;
    const fetch = (async (
      _input: RequestInfo | URL,
      _init?: RequestInit
    ): Promise<Response> => {
      count += 1;
      throw new Error(secret);
    }) as typeof globalThis.fetch;
    const options = { serviceOrigin: 'https://relic.example', fetch };
    await fixture.reportMcpError(canaryError(), 'relic_share', options);
    await fixture.reportMcpError(canaryError(), 'relic_share', options);
    expect(count).toBe(1);
  });

  test('does not send reports to a cross-origin 307 or 308 redirect', async () => {
    process.env['RELIC_ERROR_REPORTS'] = '1';
    const deliveries: string[] = [];
    const collector = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        deliveries.push(await request.text());
        return new Response(null, { status: 204 });
      },
    });
    let initialRequests = 0;
    try {
      for (const [status, error] of [
        [307, new SyntaxError('private detail')],
        [308, new RangeError('private detail')],
      ] as const) {
        const redirector = Bun.serve({
          hostname: '127.0.0.1',
          port: 0,
          fetch() {
            initialRequests++;
            return new Response(null, {
              status,
              headers: {
                location: `http://127.0.0.1:${collector.port}/collect`,
              },
            });
          },
        });
        try {
          await fixture.reportMcpError(error, 'process', {
            serviceOrigin: `http://127.0.0.1:${redirector.port}`,
          });
        } finally {
          redirector.stop(true);
        }
      }
      expect(initialRequests).toBe(2);
      expect(deliveries).toEqual([]);
    } finally {
      collector.stop(true);
    }
  });

  test('the privacy assertion fails on a deliberately broken serializer', async () => {
    process.env['RELIC_ERROR_REPORTS'] = '1';
    const source = await readFile(reporterPath, 'utf8');
    const original = 'body: JSON.stringify(report),';
    expect(source).toContain(original);
    const brokenSource = source.replace(
      original,
      'body: JSON.stringify({ ...report, message: String(error) }),'
    );
    const brokenDir = join(temp, 'broken');
    const built = await Bun.build({
      entrypoints: [reporterPath],
      outdir: brokenDir,
      target: 'node',
      define: {
        'process.env.RELIC_MCP_VERSION': JSON.stringify('1.2.3'),
        __RELIC_RELEASE_BUILD__: 'true',
      },
      plugins: [
        {
          name: 'deliberately-leak-message',
          setup(build) {
            build.onLoad({ filter: /error-report\.ts$/ }, (args) =>
              args.path === reporterPath
                ? { contents: brokenSource, loader: 'ts' }
                : undefined
            );
          },
        },
      ],
    });
    if (!built.success) throw new Error(built.logs.join('\n'));
    // A separate bundle makes the mutation specific to this negative control.
    const brokenOutput = built.outputs[0];
    if (brokenOutput === undefined) throw new Error('broken bundle missing');
    const broken: ReporterModule = await import(
      pathToFileURL(brokenOutput.path).href
    );
    const calls: Captured[] = [];
    await broken.reportMcpError(canaryError(), 'process', {
      serviceOrigin: 'https://relic.example',
      fetch: dependencies(new Error(), calls).fetch,
    });
    const leaked = calls[0];
    if (leaked === undefined) throw new Error('broken serializer did not send');
    expect(() => noCanaries(leaked)).toThrow();
  });

  test('limits a process to 20 distinct fingerprints', async () => {
    const resultPath = join(temp, 'cap.json');
    const code = `
      import { writeFileSync } from 'node:fs';
      const { reportMcpError } = await import(${JSON.stringify(releaseFixtureUrl)});
      const calls = [];
      const fetch = async (url, init) => { calls.push({url: String(url), body: String(init.body)}); return new Response(null, {status: 204}); };
      const error = new TypeError(process.env.CANARY);
      error.stack = 'TypeError: ' + process.env.CANARY + '\\n    at hidden (/private/' + process.env.CANARY + '/relic-mcp/dist/relic-mcp.js:9:2)';
      for (const route of ${JSON.stringify(MCP_ROUTES)}) await reportMcpError(error, route, {serviceOrigin: 'https://relic.example', fetch});
      await reportMcpError(error, 'relic_publish', {serviceOrigin: 'https://relic.example', fetch});
      writeFileSync(process.env.REPORT_FILE, JSON.stringify(calls));
    `;
    const child = Bun.spawn(['bun', '-e', code], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        RELIC_ERROR_REPORTS: '1',
        REPORT_FILE: resultPath,
        CANARY: secret,
      },
      signal: AbortSignal.timeout(5000),
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exit).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    const captured = JSON.parse(await readFile(resultPath, 'utf8')) as Array<{
      body: string;
    }>;
    expect(captured).toHaveLength(20);
    for (const call of captured) {
      expect(parseClientReport(JSON.parse(call.body))).not.toBeNull();
      noCanaries(call);
    }
  });

  for (const mode of ['exception', 'rejection'] as const) {
    test(`${mode} is reported before process exit`, async () => {
      const output = join(temp, `crash-${mode}.json`);
      const code = `
        import { writeFileSync } from 'node:fs';
        globalThis.fetch = async (url, init) => {
          writeFileSync(process.env.REPORT_FILE, JSON.stringify({url: String(url), body: String(init.body)}));
          return new Response(null, {status: 204});
        };
        const originalOn = process.on.bind(process);
        process.on = function (event, listener) {
          const result = originalOn(event, listener);
          if (event === 'unhandledRejection') setImmediate(() => {
            const error = new TypeError(process.env.CANARY);
            error.stack = 'TypeError: ' + process.env.CANARY + '\\n    at secret (/tmp/' + process.env.CANARY + '/relic-mcp/dist/relic-mcp.js:71:4)';
            if (process.env.CRASH_MODE === 'exception') throw error;
            Promise.reject(error);
          });
          return result;
        };
        await import(${JSON.stringify(releaseEntryUrl)});
      `;
      const child = Bun.spawn(['bun', '-e', code], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          RELIC_ERROR_REPORTS: '1',
          RELIC_SERVICE_ORIGIN: 'https://relic.example',
          REPORT_FILE: output,
          CANARY: secret,
          CRASH_MODE: mode,
        },
        signal: AbortSignal.timeout(5000),
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exit).toBe(1);
      expect(stdout).toBe('');
      noCanaries(stderr);
      const captured = JSON.parse(await readFile(output, 'utf8')) as {
        url: string;
        body: string;
      };
      expect(captured.url).toBe('https://relic.example/api/error-reports');
      expect(parseClientReport(JSON.parse(captured.body))).toEqual({
        v: 1,
        source: 'mcp',
        errorClass: 'TypeError',
        route: 'process',
        revision: '1.2.3',
        frames: [{ file: 'dist/relic-mcp.js', line: 71, column: 4 }],
        count: 1,
      });
      noCanaries(captured);
    });
  }
});
