import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { connectPipe, type CdpConnection } from '../src/cover/cdp.ts';
import { chromeArgs } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

export async function processRssBytes(
  pid: number,
  highWater = false
): Promise<number> {
  if (process.platform === 'linux') {
    const text = await readFile(
      `/proc/${pid}/${highWater ? 'status' : 'smaps_rollup'}`,
      'utf8'
    );
    const name = highWater ? 'VmHWM' : 'Rss';
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text);
    assert.ok(match?.[1], `missing ${name} for pid ${pid}`);
    return Number(match[1]) * 1024;
  }
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('ps', [
      '-o',
      'rss=',
      '-p',
      String(pid),
    ]);
    const kib = Number(stdout.trim());
    assert.ok(Number.isFinite(kib) && kib > 0, `missing RSS for pid ${pid}`);
    return kib * 1024;
  }
  throw new Error(`RSS measurement is unsupported on ${process.platform}`);
}

export async function hashFile(
  path: string,
  flipFirstByte = false
): Promise<string> {
  const hash = createHash('sha256');
  let flipped = false;
  for await (const input of createReadStream(path)) {
    const chunk = input as Buffer;
    if (flipFirstByte && !flipped && chunk.length > 0) {
      const first = Buffer.from(chunk);
      first[0] = (first[0] ?? 0) ^ 1;
      hash.update(first);
      flipped = true;
    } else {
      hash.update(chunk);
    }
  }
  assert.ok(!flipFirstByte || flipped, 'cannot corrupt an empty download');
  return hash.digest('hex');
}

export interface Page {
  readonly targetId: string;
  readonly sessionId: string;
}

export class ProofBrowser {
  private readonly downloads = new Map<string, string>();
  private readonly stopEvents: () => void;

  private constructor(
    readonly child: ChildProcess,
    readonly cdp: CdpConnection,
    readonly downloadDirectory: string
  ) {
    this.stopEvents = cdp.onEvent((event) => {
      if (event.method !== 'Browser.downloadProgress') return;
      const guid = event.params['guid'];
      const state = event.params['state'];
      if (typeof guid === 'string' && typeof state === 'string')
        this.downloads.set(guid, state);
    });
  }

  static async start(
    scratch: string,
    servicePort: number,
    usercontentPort: number
  ): Promise<ProofBrowser> {
    const supplied = process.env['RELIC_PROOF_CHROME_PATH'];
    assert.ok(
      supplied && isAbsolute(supplied),
      'Set RELIC_PROOF_CHROME_PATH to an isolated headless Chromium executable'
    );
    const binary = await realpath(supplied);
    if (process.platform === 'darwin') {
      assert.ok(
        basename(binary).includes('headless-shell'),
        'On macOS use chrome-headless-shell, never the user Chrome app'
      );
    }
    const profile = join(scratch, 'browser-profile');
    const downloads = join(scratch, 'downloads');
    await mkdir(profile);
    await mkdir(downloads);
    const args = chromeArgs(binary, profile).map((argument) =>
      argument === '--proxy-bypass-list=<-loopback>'
        ? `--proxy-bypass-list=<-loopback>;127.0.0.1:${servicePort};localhost:${usercontentPort}`
        : argument === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'
          : argument
    );
    const launch = createBrowserHeadlessLaunch(
      [
        ...args,
        '--autoplay-policy=no-user-gesture-required',
        '--disable-service-workers',
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ],
      profile
    );
    const child = spawn(binary, launch.args, {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    });
    // Keep stderr drained so the owned browser cannot block on a full pipe.
    child.stderr?.resume();
    const cdp = connectPipe(
      child.stdio[3] as Writable,
      child.stdio[4] as Readable
    );
    try {
      await attestBrowserHeadless(cdp, launch);
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: downloads,
        eventsEnabled: true,
      });
      return new ProofBrowser(child, cdp, downloads);
    } catch (error) {
      cdp.dispose();
      child.kill('SIGKILL');
      throw error;
    }
  }

  async page(
    url: string,
    sessionToken?: string,
    prelude?: string
  ): Promise<Page> {
    const created = await this.cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const targetId = created['targetId'];
    assert.ok(typeof targetId === 'string', 'CDP returned no target ID');
    const attached = await this.cdp.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    const sessionId = attached['sessionId'];
    assert.ok(typeof sessionId === 'string', 'CDP returned no session ID');
    await this.cdp.send('Page.enable', {}, sessionId);
    await this.cdp.send('Runtime.enable', {}, sessionId);
    await this.cdp.send('Network.enable', {}, sessionId);
    await this.cdp.send(
      'Network.setCacheDisabled',
      { cacheDisabled: true },
      sessionId
    );
    if (prelude) {
      await this.cdp.send(
        'Page.addScriptToEvaluateOnNewDocument',
        { source: prelude },
        sessionId
      );
    }
    if (sessionToken) {
      await this.cdp.send(
        'Network.setCookie',
        {
          name: 'relic_session',
          value: sessionToken,
          url: new URL(url).origin,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
        sessionId
      );
    }
    await this.navigate({ targetId, sessionId }, url);
    return { targetId, sessionId };
  }

  async navigate(page: Page, url: string): Promise<void> {
    const result = await this.cdp.send(
      'Page.navigate',
      { url },
      page.sessionId
    );
    assert.equal(
      result['errorText'],
      undefined,
      `navigation failed: ${String(result['errorText'])}`
    );
  }

  async evaluate<T>(page: Page, expression: string): Promise<T> {
    const response = await this.cdp.send(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: true,
        returnByValue: true,
      },
      page.sessionId
    );
    assert.equal(
      response['exceptionDetails'],
      undefined,
      `browser evaluation failed: ${JSON.stringify(response['exceptionDetails'])}`
    );
    const result = response['result'];
    assert.ok(
      result !== null && typeof result === 'object',
      'CDP returned no result'
    );
    const value = ('value' in result ? result.value : undefined) as T;
    return value;
  }

  async waitFor<T>(
    page: Page,
    expression: string,
    label: string,
    timeoutMs = 180_000
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let value: T | undefined;
    while (Date.now() < deadline) {
      value = await this.evaluate<T>(page, expression);
      if (value) return value;
      await Bun.sleep(100);
    }
    const text = await this.evaluate<string>(
      page,
      'document.body?.innerText?.slice(0, 4000) ?? ""'
    ).catch(() => 'page unavailable');
    throw new Error(
      `timed out waiting for ${label}; last=${JSON.stringify(value)}; page=${text}`
    );
  }

  async pressure(page: Page): Promise<void> {
    await this.cdp.send('HeapProfiler.collectGarbage', {}, page.sessionId);
    await this.cdp.send(
      'Memory.simulatePressureNotification',
      { level: 'critical' },
      page.sessionId
    );
    await Bun.sleep(500);
  }

  async rendererRss(includeUtility = false): Promise<number> {
    const response = await this.cdp.send('SystemInfo.getProcessInfo');
    const processes = response['processInfo'];
    assert.ok(Array.isArray(processes), 'CDP returned no browser process list');
    const selected: number[] = [];
    let rendererCount = 0;
    for (const entry of processes) {
      if (entry !== null && typeof entry === 'object') {
        if (entry.type === 'renderer') rendererCount++;
        if (
          entry.type === 'renderer' ||
          (includeUtility && entry.type === 'utility')
        ) {
          assert.ok(
            typeof entry.id === 'number',
            'CDP process has no process ID'
          );
          selected.push(entry.id);
        }
      }
    }
    assert.ok(rendererCount > 0, 'CDP returned no renderer process');
    let rss = 0;
    for (const pid of selected) rss += await processRssBytes(pid);
    return rss;
  }

  async download(page: Page): Promise<string> {
    const willBegin = this.cdp.waitForEvent('Browser.downloadWillBegin', {
      timeoutMs: 30_000,
    });
    await this.evaluate(
      page,
      `(() => {
      const button = document.querySelector('button.action-download');
      if (!(button instanceof HTMLButtonElement)) throw new Error('Download button missing');
      button.click();
    })()`
    );
    const event = await willBegin;
    const guid = event.params['guid'];
    assert.ok(typeof guid === 'string', 'download has no GUID');
    const end = Date.now() + 180_000;
    while (Date.now() < end) {
      const status = this.downloads.get(guid);
      if (status === 'completed') return join(this.downloadDirectory, guid);
      assert.notEqual(status, 'canceled', 'browser canceled download');
      await Bun.sleep(100);
    }
    throw new Error('download did not complete');
  }

  async memoryNegativeControl(page: Page): Promise<number> {
    await this.pressure(page);
    const before = await this.rendererRss();
    await this.evaluate(
      page,
      `(() => {
      const bytes = new Uint8Array(512 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 1;
      globalThis.__largeProofAllocation = bytes;
    })()`
    );
    const growth = (await this.rendererRss()) - before;
    assert.ok(
      growth > 400 * MIB,
      `memory sampler missed 512 MiB allocation: growth=${growth}`
    );
    await this.evaluate(page, 'globalThis.__largeProofAllocation = null');
    await this.pressure(page);
    return growth;
  }

  async closePage(page: Page): Promise<void> {
    await this.cdp.send('Target.closeTarget', { targetId: page.targetId });
  }

  async close(): Promise<void> {
    this.stopEvents();
    const { promise, resolve } = Promise.withResolvers<void>();
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      resolve();
    else this.child.once('exit', () => resolve());
    await this.cdp.send('Browser.close').catch(() => {});
    this.cdp.dispose();
    if (this.child.exitCode === null && this.child.signalCode === null)
      this.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null)
        this.child.kill('SIGKILL');
    }, 3000);
    await promise;
    clearTimeout(timer);
  }
}
