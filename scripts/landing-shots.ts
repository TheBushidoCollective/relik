#!/usr/bin/env bun
/**
 * Renders the three relik.link landing-page product shots: the Relic viewer
 * showing a real published relic, captured from an isolated headless Chrome.
 *
 * Three existing repo files are published through the real publish flow to
 * in-memory loopback services (a service origin and a usercontent origin, the
 * same wiring as packages/relic-mcp/test/comment-popover-path.ts). Each full
 * share URL, key fragment included, is opened in a fresh browser context at
 * 1440x900 and screenshotted only once the viewer has decrypted and rendered it.
 *
 * Output: packages/relic-viewer/public/{landing-markdown,landing-html,landing-code-dark}.png
 *
 * Prerequisites: `bun install`, then `bun packages/relic-viewer/build.ts`.
 * Browser: chrome-headless-shell from the Playwright cache, or
 * RELIC_LANDING_CHROME=/path/to/chrome-headless-shell. This script spawns its own
 * shell on a private port with a throwaway profile and kills only that process.
 */

import { execFile, spawn } from 'node:child_process';
import {
  access,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createApp } from '../packages/relic-server/src/app.ts';
import { diskAssets } from '../packages/relic-server/src/assets.ts';
import { MemoryStorage } from '../packages/relic-server/src/storage.ts';
import { MemoryStore } from '../packages/relic-server/src/store.ts';
import { nodeFiles } from '../packages/relic-mcp/src/files.ts';
import {
  type PublishDeps,
  publish,
} from '../packages/relic-mcp/src/publish.ts';

const execFileAsync = promisify(execFile);

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const viewerDist = join(repoRoot, 'packages/relic-viewer/dist');
const outDir =
  process.env['LANDING_SHOTS_OUT'] ??
  join(repoRoot, 'packages/relic-viewer/public');
const VIEWPORT = { width: 1440, height: 900 };
const MAX_BYTES = 250 * 1024;
const RENDER_TIMEOUT_MS = 30_000;
/** Minimum visible text before a pane counts as decrypted content, not a plate. */
const MIN_CONTENT_CHARS = 200;
/** Output names to render; empty means all shots. */
const only = process.argv.slice(2);

type Kind = 'markdown' | 'code' | 'html';
type Scheme = 'light' | 'dark';

interface Shot {
  readonly file: string;
  readonly source: string;
  readonly kind: Kind;
  readonly scheme: Scheme;
  readonly publishAs?: string;
}

const SHOTS: readonly Shot[] = [
  {
    file: 'landing-markdown.png',
    source: join(repoRoot, 'packages/relic-mcp/README.md'),
    kind: 'markdown',
    scheme: 'light',
  },
  {
    file: 'landing-html.png',
    source: join(repoRoot, 'scripts/fixtures/landing-release-notes.html'),
    kind: 'html',
    scheme: 'light',
    publishAs: 'release-notes.html',
  },
  {
    file: 'landing-code-dark.png',
    source: join(repoRoot, 'packages/relic-server/src/ratelimit.ts'),
    kind: 'code',
    scheme: 'dark',
  },
];

const scratch = await mkdtemp(join(tmpdir(), 'relic-landing-shots-'));
// Publish state lives in a throwaway file so no prior run's source is reused.
process.env['RELIC_PUBLISH_STATE'] = join(scratch, 'state.json');

await access(join(viewerDist, 'viewer.js')).catch(() => {
  throw new Error(
    `viewer is not built at ${viewerDist}: run bun packages/relic-viewer/build.ts`
  );
});

// --- Loopback services, as in comment-popover-path.ts ---

const store = new MemoryStore();
const operatorTokens = new Map([['operator-token', 'landing-shots-operator']]);

let handler: ((request: Request) => Promise<Response>) | undefined;
const service = Bun.serve({
  port: 0,
  async fetch(request) {
    if (!handler) return new Response('Not ready', { status: 503 });
    return handler(request);
  },
});
const origin = `http://127.0.0.1:${service.port}`;
const storage = new MemoryStorage(`${origin}/__storage`);

const usercontentService = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/sandbox.html') {
      return new Response(Bun.file(join(viewerDist, 'sandbox.html')), {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy':
            "default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
        },
      });
    }
    if (url.pathname === '/sandbox.js') {
      return new Response(Bun.file(join(viewerDist, 'sandbox.js')), {
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
      });
    }
    const file = Bun.file(join(viewerDist, url.pathname.slice(1)));
    if (await file.exists()) return new Response(file);
    return new Response('Not found', { status: 404 });
  },
});
const usercontentOrigin = `http://127.0.0.1:${usercontentService.port}`;

const app = createApp({
  config: { serviceOrigin: origin, usercontentOrigin },
  store,
  storage,
  now: () => Date.now(),
  operatorTokens,
  assets: diskAssets(viewerDist),
  mailer: {
    send: async () => {},
    sendMail: async () => {},
  },
});

handler = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  if (
    url.pathname.startsWith('/__storage/upload/') &&
    request.method === 'PUT'
  ) {
    const relicId = url.pathname.slice('/__storage/upload/'.length);
    storage.put(relicId, new Uint8Array(await request.arrayBuffer()));
    return new Response(null, { status: 200 });
  }
  if (url.pathname.startsWith('/__storage/o/') && request.method === 'GET') {
    const relicId = url.pathname.slice('/__storage/o/'.length);
    const bytes = await storage.read(relicId);
    if (!bytes) return new Response('Not found', { status: 404 });
    return new Response(Buffer.from(bytes), {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }
  return app.fetch(request);
};

const publishDeps: PublishDeps = {
  serviceOrigin: origin,
  relicOrigin: origin,
  files: nodeFiles,
  fetch: globalThis.fetch,
  clientName: 'relic-mcp/landing-shots',
  renderCover: async () => ({
    status: 'skipped',
    reason: 'browser_disabled',
    detail: 'landing-shots renders no cover',
  }),
};

// --- Headless Chrome, spawned and owned by this process ---

async function findHeadlessShell(): Promise<string> {
  const override = process.env['RELIC_LANDING_CHROME'];
  if (override) return override;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const entries = (await readdir(cache).catch(() => []))
    .filter((entry) => entry.startsWith('chromium_headless_shell-'))
    .sort(
      (a, b) =>
        Number(b.slice(b.lastIndexOf('-') + 1)) -
        Number(a.slice(a.lastIndexOf('-') + 1))
    );
  const platformDirs = [
    'chrome-headless-shell-mac-arm64',
    'chrome-headless-shell-linux64',
  ];
  for (const entry of entries) {
    for (const dir of platformDirs) {
      const candidate = join(cache, entry, dir, 'chrome-headless-shell');
      if (
        await access(candidate).then(
          () => true,
          () => false
        )
      ) {
        return candidate;
      }
    }
  }
  throw new Error(
    'no chrome-headless-shell found: run bunx playwright install chromium-headless-shell'
  );
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  return port;
}

class CdpClient {
  readonly #socket: WebSocket;
  #nextId = 1;
  readonly #pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (message.id === undefined) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  static connect(url: string): Promise<CdpClient> {
    const { promise, resolve, reject } = Promise.withResolvers<CdpClient>();
    const socket = new WebSocket(url);
    socket.addEventListener('open', () => resolve(new CdpClient(socket)), {
      once: true,
    });
    socket.addEventListener(
      'error',
      () => reject(new Error(`CDP socket failed: ${url}`)),
      { once: true }
    );
    return promise;
  }

  send<T = unknown>(
    method: string,
    params: object = {},
    sessionId?: string
  ): Promise<T> {
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    this.#pending.set(id, {
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    this.#socket.send(
      JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      })
    );
    return promise;
  }

  close(): void {
    this.#socket.close();
  }
}

interface EvaluateResult {
  result: { value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

class PageSession {
  readonly #cdp: CdpClient;
  readonly #sessionId: string;

  constructor(cdp: CdpClient, sessionId: string) {
    this.#cdp = cdp;
    this.#sessionId = sessionId;
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    return this.#cdp.send<T>(method, params, this.#sessionId);
  }

  async evaluate<T>(expression: string, contextId?: number): Promise<T> {
    const response = await this.send<EvaluateResult>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...(contextId === undefined ? {} : { contextId }),
    });
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text;
      throw new Error(`page evaluate failed: ${detail}`);
    }
    return response.result.value as T;
  }
}

interface Probe {
  ready: boolean;
  why: string;
  error?: string;
}

/** Shared guard: an error banner fails the shot; a render-in-progress pill waits. */
const COMMON_GUARD = `
  const alert = document.querySelector('[role="alert"], .error-banner, .relic-error');
  if (alert) return { ready: false, why: 'error banner', error: (alert.textContent || '').trim().slice(0, 300) };
  if (document.querySelector('.render-status, #load-phase, .pdf-status-card')) {
    return { ready: false, why: 'render status still visible' };
  }
`;

/** Markdown and code panes both mount their content under `.doc` on the service origin. */
const TEXT_PANE_PROBE = `(() => {
  ${COMMON_GUARD}
  const pane = document.querySelector('.doc');
  if (!pane) return { ready: false, why: 'no .doc pane yet' };
  const chars = pane.innerText.trim().length;
  return { ready: chars >= ${MIN_CONTENT_CHARS}, why: 'doc chars=' + chars };
})()`;

/** HTML relics mount a sandboxed iframe on the usercontent origin; its content is probed separately. */
const FRAME_PANE_PROBE = `(() => {
  ${COMMON_GUARD}
  const frame = document.querySelector('.usercontent-frame');
  if (!frame) return { ready: false, why: 'no sandbox frame yet' };
  const box = frame.getBoundingClientRect();
  return { ready: box.width > 0 && box.height > 0, why: 'frame ' + Math.round(box.width) + 'x' + Math.round(box.height) };
})()`;

/**
 * Runs inside the sandboxed frame's isolated world. Waits two animation frames so
 * the document has been laid out and painted before its text is counted.
 */
const SANDBOX_FRAME_PROBE = `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
  const text = (document.body ? document.body.innerText : '').trim();
  resolve({
    ready: text.length >= ${MIN_CONTENT_CHARS},
    why: 'sandbox chars=' + text.length,
    sample: text.slice(0, 120),
  });
})))`;

async function waitForRendered(page: PageSession, kind: Kind): Promise<string> {
  const deadline = Date.now() + RENDER_TIMEOUT_MS;
  let last = 'not started';
  let worldFrameId: string | undefined;
  let worldContextId: number | undefined;

  while (Date.now() < deadline) {
    const probe = await page.evaluate<Probe>(
      kind === 'html' ? FRAME_PANE_PROBE : TEXT_PANE_PROBE
    );
    if (probe.error) throw new Error(`viewer error banner: ${probe.error}`);
    last = probe.why;

    if (probe.ready && kind !== 'html') return probe.why;

    if (probe.ready && kind === 'html') {
      const tree = await page.send<{
        frameTree: { childFrames?: Array<{ frame: { id: string } }> };
      }>('Page.getFrameTree');
      const frameId = tree.frameTree.childFrames?.[0]?.frame.id;
      if (!frameId) {
        last = 'no child frame in the page tree';
      } else {
        if (worldFrameId !== frameId || worldContextId === undefined) {
          try {
            const world = await page.send<{ executionContextId: number }>(
              'Page.createIsolatedWorld',
              {
                frameId,
                worldName: 'landing-shots-probe',
                grantUniveralAccess: true,
              }
            );
            worldFrameId = frameId;
            worldContextId = world.executionContextId;
          } catch (error) {
            last = `isolated world unavailable: ${(error as Error).message}`;
          }
        }
        if (worldContextId !== undefined) {
          try {
            const sandbox = await page.evaluate<{
              ready: boolean;
              why: string;
            }>(SANDBOX_FRAME_PROBE, worldContextId);
            last = sandbox.why;
            if (sandbox.ready) return sandbox.why;
          } catch {
            // The sandboxed document was replaced; rebuild the world next poll.
            worldContextId = undefined;
            last = 'sandbox document replaced, retrying';
          }
        }
      }
    }

    await Bun.sleep(200);
  }
  throw new Error(`not rendered within ${RENDER_TIMEOUT_MS}ms: ${last}`);
}

async function captureShot(
  browser: CdpClient,
  url: string,
  shot: Shot,
  outPath: string
): Promise<void> {
  const { browserContextId } = await browser.send<{ browserContextId: string }>(
    'Target.createBrowserContext',
    { disposeOnDetach: true }
  );
  let targetId: string | undefined;
  try {
    ({ targetId } = await browser.send<{ targetId: string }>(
      'Target.createTarget',
      { url: 'about:blank', browserContextId }
    ));
    const { sessionId } = await browser.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId, flatten: true }
    );
    const page = new PageSession(browser, sessionId);

    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: shot.scheme }],
    });

    const navigated = await page.send<{ errorText?: string }>('Page.navigate', {
      url,
    });
    if (navigated.errorText) {
      throw new Error(`navigation failed: ${navigated.errorText}`);
    }

    const rendered = await waitForRendered(page, shot.kind);
    console.log(`  ${shot.file}: rendered (${rendered})`);

    await page.evaluate('document.fonts.ready.then(() => true)');
    await Bun.sleep(300);

    const capture = await page.send<{ data: string }>(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: false,
        clip: {
          x: 0,
          y: 0,
          width: VIEWPORT.width,
          height: VIEWPORT.height,
          scale: 1,
        },
      }
    );
    await writeFile(outPath, Buffer.from(capture.data, 'base64'));
  } finally {
    if (targetId) {
      await browser
        .send('Target.closeTarget', { targetId })
        .catch(() => undefined);
    }
    await browser
      .send('Target.disposeBrowserContext', { browserContextId })
      .catch(() => undefined);
  }
}

// --- Optimisation, only when a shot exceeds the byte budget ---

/**
 * Keeps the 1440x900 crop and only reduces the palette. Lossless optimisers
 * run first when installed; otherwise ffmpeg quantises to fewer colours.
 */
async function fitWithinBudget(path: string): Promise<void> {
  if ((await Bun.file(path).size) <= MAX_BYTES) return;

  const pngquant = Bun.which('pngquant');
  if (pngquant) {
    await execFileAsync(pngquant, [
      '--force',
      '--quality=80-100',
      '--output',
      path,
      path,
    ]);
    if ((await Bun.file(path).size) <= MAX_BYTES) return;
  }

  const raw = `${path}.raw.png`;
  await rename(path, raw);
  try {
    for (const colors of [256, 128, 64]) {
      await execFileAsync('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        raw,
        '-vf',
        `split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
        '-frames:v',
        '1',
        path,
      ]);
      if ((await Bun.file(path).size) <= MAX_BYTES) return;
    }
    throw new Error(
      `${path} is still over ${MAX_BYTES} bytes after quantising`
    );
  } finally {
    await rm(raw, { force: true });
  }
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// --- Run ---

const shellPath = await findHeadlessShell();
const profile = await mkdtemp(join(tmpdir(), 'landing-shots-profile-'));
const debugPort = freePort();

const chrome = spawn(
  shellPath,
  [
    '--headless',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let stopped = false;
function stopChrome(): void {
  if (stopped) return;
  stopped = true;
  // Only the shell this process spawned, never a process found by name.
  chrome.kill('SIGTERM');
}
process.on('SIGINT', () => {
  stopChrome();
  process.exit(130);
});

const outputs: Array<{
  path: string;
  bytes: number;
  width: number;
  height: number;
}> = [];
let browser: CdpClient | undefined;

try {
  let version: { Browser?: string; webSocketDebuggerUrl?: string } | undefined;
  const deadline = Date.now() + 15_000;
  while (!version?.webSocketDebuggerUrl && Date.now() < deadline) {
    version = await fetch(`http://127.0.0.1:${debugPort}/json/version`)
      .then((response) => response.json() as Promise<typeof version>)
      .catch(() => undefined);
    if (!version?.webSocketDebuggerUrl) await Bun.sleep(100);
  }
  if (!version?.webSocketDebuggerUrl) {
    throw new Error('chrome-headless-shell did not open its debugging port');
  }
  if (!String(version.Browser).startsWith('HeadlessChrome/')) {
    throw new Error(`refusing non-headless browser: ${version.Browser}`);
  }
  browser = await CdpClient.connect(version.webSocketDebuggerUrl);

  await Bun.write(
    join(scratch, 'shell.txt'),
    `${shellPath}\n${version.Browser}\n`
  );

  // Optional argv selects shots by output name, e.g. `bun scripts/landing-shots.ts landing-html.png`.
  const selected = SHOTS.filter(
    (shot) => only.length === 0 || only.includes(shot.file)
  );
  if (only.length > 0 && selected.length !== new Set(only).size) {
    throw new Error(`unknown shot name in: ${only.join(', ')}`);
  }
  for (const shot of selected) {
    console.log(`Publishing ${shot.source.slice(repoRoot.length)} ...`);
    const published = await publish(
      { path: shot.source, filename: shot.publishAs, cover: false },
      publishDeps
    );
    console.log(`  relic ${published.relic_id} (${published.renderer_class})`);

    const outPath = join(outDir, shot.file);
    await captureShot(browser, published.url, shot, outPath);
    await fitWithinBudget(outPath);

    const bytes = await Bun.file(outPath).arrayBuffer();
    const { width, height } = pngDimensions(new Uint8Array(bytes));
    if (width !== VIEWPORT.width || height !== VIEWPORT.height) {
      throw new Error(`${shot.file} is ${width}x${height}, expected 1440x900`);
    }
    outputs.push({ path: outPath, bytes: bytes.byteLength, width, height });
  }

  for (const output of outputs) {
    console.log(
      `${output.path}  ${output.bytes} bytes  ${output.width}x${output.height}`
    );
  }
} finally {
  browser?.close();
  stopChrome();
  await new Promise<void>((resolve) => {
    if (chrome.exitCode !== null || chrome.signalCode !== null) resolve();
    else chrome.once('exit', () => resolve());
    setTimeout(resolve, 5_000);
  });
  await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  await usercontentService.stop(true);
  await service.stop(true);
  await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
