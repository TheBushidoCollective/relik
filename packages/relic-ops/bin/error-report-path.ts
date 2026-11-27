import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateRelicId } from '@relic/format';
import {
  type ErrorReport,
  fingerprintOf,
  parseLoggedReport,
} from '@relic/format/error-report';
import { createApp, type RelicApp } from '@relic/server/src/app.ts';
import { diskAssets } from '@relic/server/src/assets.ts';
import { createErrorReporter } from '@relic/server/src/error-report.ts';
import { MemoryStore } from '@relic/server/src/store.ts';
import { connectPipe } from '../../relic-mcp/src/cover/cdp.ts';
import {
  chromeArgs,
  discoverChrome,
} from '../../relic-mcp/src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from '../../relic-mcp/test/browser-headless.ts';
import { parseRegion, renderRegion } from '../src/render.ts';

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== '--leg' ||
  !['server', 'viewer', 'mcp', 'all'].includes(args[1] ?? '')
)
  throw new Error('Usage: error-report-path.ts --leg server|viewer|mcp|all');
const leg = args[1];
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), 'relik-error-path-'));
const revision = 'a'.repeat(40);
const id = generateRelicId();
const fragment = `#${'q'.repeat(43)}`;
const canaries = [
  id,
  fragment,
  'jane.doe@example.com',
  '/Users/jane/Secret Plans.pdf',
];
const secret = canaries.join(' ');
const logs: string[] = [];
const requests: string[] = [];
const reporter = createErrorReporter({
  revision,
  emit: (line) => logs.push(line),
});
let app: RelicApp;
let brokenApp: RelicApp;
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/error-reports')
      requests.push(await request.clone().text());
    return (url.pathname.endsWith('/mint') ? brokenApp : app).fetch(request);
  },
});
const origin = `http://127.0.0.1:${server.port}`;
const usercontent = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch: (request) => app.fetch(request),
});
const assets = diskAssets(join(repo, 'packages/relic-viewer/dist'));
const config = {
  revision,
  serviceOrigin: origin,
  usercontentOrigin: `http://127.0.0.1:${usercontent.port}`,
};
class ThrowingStore extends MemoryStore {
  override async getTombstone(): Promise<never> {
    const error = new TypeError(secret);
    error.stack = `TypeError: ${secret}\n    at hidden (${repo}packages/relic-server/src/app.ts:23:4)`;
    throw error;
  }
}
app = createApp({ config, assets, errorReporter: reporter });
brokenApp = createApp({
  config,
  assets,
  store: new ThrowingStore(),
  errorReporter: reporter,
});

function clean(value: string): void {
  for (const canary of canaries)
    assert.ok(!value.includes(canary), 'a canary reached a report');
}

function check(source: ErrorReport['source']): void {
  const line = logs
    .map((text) => JSON.parse(text) as { report: unknown; fingerprint: string })
    .find((entry) => parseLoggedReport(entry.report)?.source === source);
  assert.ok(line, `missing ${source} log`);
  const report = parseLoggedReport(line.report);
  assert.ok(report);
  assert.equal(line.fingerprint, fingerprintOf(report));
  const body = renderRegion({
    v: 1,
    fingerprint: line.fingerprint,
    source: report.source,
    errorClass: report.errorClass,
    route: report.route,
    builds: [{ revision: report.revision, frames: report.frames }],
    count7d: report.count,
  });
  assert.ok(parseRegion(body));
  clean(JSON.stringify({ line, requests, body }));
}

async function serverPath(): Promise<void> {
  const response = await fetch(
    `${origin}/api/relics/${id}/mint?email=${encodeURIComponent(canaries[2]!)}`,
    { method: 'POST' }
  );
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'Something went wrong!');
  check('server');
  console.log('ERROR_REPORT_SERVER_PATH_OK');
}

async function viewerPath(): Promise<boolean> {
  const chromePath = process.env.RELIC_CHROME_PATH;
  if (!chromePath) {
    if (process.env.CI) throw new Error('CI requires RELIC_CHROME_PATH');
    console.log(
      'ERROR_REPORT_VIEWER_PATH_SKIPPED: RELIC_CHROME_PATH is not set'
    );
    return false;
  }
  const found = await discoverChrome(chromePath);
  if (found.kind !== 'found')
    throw new Error('RELIC_CHROME_PATH is not an executable browser');
  const profile = await mkdtemp(join(scratch, 'chrome-'));
  const argv = chromeArgs(found.path, profile)
    .filter((arg) => !arg.startsWith('--proxy-'))
    .map((arg) =>
      arg === '--host-resolver-rules=MAP * ~NOTFOUND'
        ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        : arg
    );
  const launch = createBrowserHeadlessLaunch(argv, profile);
  const child = spawn(found.path, launch.args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, DISPLAY: '', WAYLAND_DISPLAY: '' },
  });
  const cdp = connectPipe(
    child.stdio[3] as Writable,
    child.stdio[4] as Readable
  );
  try {
    await attestBrowserHeadless(cdp, launch);
    const target = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    if (typeof attached.sessionId !== 'string')
      throw new Error('Missing browser session');
    const session = attached.sessionId;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId: session,
      timeoutMs: 30_000,
    });
    const navigation = await cdp.send(
      'Page.navigate',
      { url: `${origin}/${id}${fragment}` },
      session
    );
    assert.equal(navigation.errorText, undefined);
    await loaded;
    for (let i = 0; i < 200; i++) {
      const state = await cdp.send(
        'Runtime.evaluate',
        {
          expression: "document.documentElement.dataset.viewerBooted === '1'",
          returnByValue: true,
        },
        session
      );
      const result = state.result;
      if (
        typeof result === 'object' &&
        result !== null &&
        'value' in result &&
        result.value === true
      )
        break;
      if (i === 199) throw new Error('Viewer did not boot');
      await Bun.sleep(50);
    }
    // The error occurs in a real viewer.js call stack; the page reporter handles
    // the resulting unhandled rejection, not an invented report event.
    const expression = `void import('/assets/viewer.js').then(m => { const deps = new Proxy({}, { get(_target, key) { if (key === 'keyVault') throw new TypeError(${JSON.stringify(secret)}); } }); void m.boot({dataset: {view: 'dashboard'}}, deps); });`;
    const evaluation = await cdp.send(
      'Runtime.evaluate',
      { expression },
      session
    );
    if (evaluation.exceptionDetails)
      throw new Error('Viewer proof injection failed');
    for (
      let i = 0;
      i < 200 && !logs.some((line) => line.includes('"source":"viewer"'));
      i++
    )
      await Bun.sleep(50);
    check('viewer');
    console.log('ERROR_REPORT_VIEWER_PATH_OK');
    return true;
  } finally {
    cdp.dispose();
    child.kill();
    await rm(profile, { recursive: true, force: true });
  }
}

async function mcpPath(): Promise<void> {
  // Build the actual entrypoint using the release defines in relic-mcp/build.ts,
  // without changing the installed development bundle or making external calls.
  const outdir = join(scratch, 'relic-mcp', 'dist');
  const built = await Bun.build({
    entrypoints: [join(repo, 'packages/relic-mcp/src/index.ts')],
    outdir,
    target: 'node',
    format: 'esm',
    minify: false,
    splitting: false,
    naming: 'relic-mcp.js',
    define: {
      'process.env.RELIC_MCP_VERSION': JSON.stringify('1.2.3'),
      __RELIC_RELEASE_BUILD__: 'true',
      'process.env.RELIC_MCP_COVER_DIR': JSON.stringify('./cover/'),
      __RELIC_PROGRAM_ASSET_BASE__: JSON.stringify('./program/'),
    },
  });
  if (!built.success) throw new Error('MCP release proof bundle failed');
  const bundle = pathToFileURL(join(outdir, 'relic-mcp.js')).href;
  const script = `const original = process.on.bind(process); process.on = function(event, listener) { const result = original(event, listener); if (event === 'unhandledRejection') setImmediate(() => { const error = new TypeError(process.env.CANARY); error.stack = 'TypeError: ' + process.env.CANARY + '\\n    at hidden (' + process.env.BUNDLE_PATH + ':71:4)'; throw error; }); return result; }; await import(process.env.BUNDLE_URL);`;
  const child = Bun.spawn(['bun', '-e', script], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      RELIC_ERROR_REPORTS: '1',
      RELIC_SERVICE_ORIGIN: origin,
      CANARY: secret,
      BUNDLE_PATH: join(outdir, 'relic-mcp.js'),
      BUNDLE_URL: bundle,
    },
    signal: AbortSignal.timeout(15_000),
  });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  assert.equal(exit, 1);
  assert.equal(stdout, '');
  clean(stderr);
  check('mcp');
  console.log('ERROR_REPORT_MCP_PATH_OK');
}

try {
  if (leg === 'server' || leg === 'all') await serverPath();
  const viewerRan =
    leg === 'viewer' || leg === 'all' ? await viewerPath() : true;
  if (leg === 'mcp' || leg === 'all') await mcpPath();
  if (leg === 'all')
    console.log(
      viewerRan ? 'ERROR_REPORT_PATH_OK' : 'ERROR_REPORT_PATH_PARTIAL'
    );
} finally {
  server.stop(true);
  usercontent.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
