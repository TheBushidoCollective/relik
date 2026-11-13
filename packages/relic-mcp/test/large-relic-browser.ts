import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { promisify } from 'node:util';
import { dlopen, FFIType, ptr } from 'bun:ffi';
import { connectPipe, type CdpConnection } from '../src/cover/cdp.ts';
import { chromeArgs } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const execFileAsync = promisify(execFile);
const MIB = 1024 * 1024;

// The viewer catches ContentStoreError and keeps its cause out of the dead card.
// Preserve the original Blob result or exception; report only failures in this proof.
const BLOB_FAILURE_PRELUDE = String.raw`(() => {
  const parents = new WeakMap();
  const report = (op, blob, name, message) => {
    // Keep a failed Blob's native status alive until the proof can read blob-internals.
    globalThis.__largeProofFailedBlob = blob;
    globalThis.__largeProofFailedParentBlob = parents.get(blob) ?? blob;
    console.warn('LARGE_BLOB_FAILURE ' + JSON.stringify({
      op, size: blob.size, name, message: String(message).slice(0, 300), t: Math.round(performance.now()),
    }));
  };
  const { slice, arrayBuffer } = Blob.prototype;
  Blob.prototype.slice = function (...args) {
    try {
      const result = slice.apply(this, args);
      parents.set(result, this);
      return result;
    }
    catch (error) {
      report('slice', this, error?.name, error?.message ?? error);
      throw error;
    }
  };
  Blob.prototype.arrayBuffer = function () {
    const size = this.size;
    try {
      return arrayBuffer.call(this).then(
        (buffer) => {
          if (buffer.byteLength !== size) report('arrayBuffer', this, 'ShortRead', buffer.byteLength + '/' + size);
          return buffer;
        },
        (error) => {
          report('arrayBuffer', this, error?.name, error?.message ?? error);
          throw error;
        },
      );
    } catch (error) {
      report('arrayBuffer', this, error?.name, error?.message ?? error);
      throw error;
    }
  };
})()`;

// RUSAGE_INFO_V4 has a 16-byte UUID followed by 35 uint64 fields.
const RUSAGE_INFO_V4 = 4;
const RUSAGE_INFO_V4_SIZE = 296;
const PHYS_FOOTPRINT_OFFSET = 72;
const darwinRusage =
  process.platform === 'darwin'
    ? dlopen('/usr/lib/libSystem.B.dylib', {
        proc_pid_rusage: {
          args: [FFIType.i32, FFIType.i32, FFIType.ptr],
          returns: FFIType.i32,
        },
      })
    : undefined;

export interface ProcessMemory {
  readonly type: 'renderer' | 'utility';
  readonly footprint: number;
  readonly rss: number;
}

export type MemorySnapshot = ReadonlyMap<number, ProcessMemory>;

export interface MemoryGrowth {
  readonly footprint: number;
  readonly rss: number;
  readonly added: number[];
  readonly exited: number[];
}

export function memoryMeasurement(): 'phys_footprint' | 'rss_anon_swap' {
  if (process.platform === 'darwin') return 'phys_footprint';
  if (process.platform === 'linux') return 'rss_anon_swap';
  throw new Error(
    `Footprint measurement is unsupported on ${process.platform}`
  );
}

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

export async function processFootprintBytes(pid: number): Promise<number> {
  assert.ok(
    Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff,
    `invalid process ID ${pid}`
  );
  if (process.platform === 'darwin') {
    assert.ok(darwinRusage, 'Darwin rusage library is unavailable');
    const data = new Uint8Array(RUSAGE_INFO_V4_SIZE);
    const result = darwinRusage.symbols.proc_pid_rusage(
      pid,
      RUSAGE_INFO_V4,
      ptr(data)
    );
    assert.equal(result, 0, `proc_pid_rusage failed for pid ${pid}: ${result}`);
    const footprint = Number(
      new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(
        PHYS_FOOTPRINT_OFFSET,
        true
      )
    );
    assert.ok(
      Number.isSafeInteger(footprint) && footprint > 0,
      `invalid physical footprint for pid ${pid}: ${footprint}`
    );
    return footprint;
  }
  if (process.platform === 'linux') {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const fieldBytes = (name: string): number => {
      const match = new RegExp(`^${name}:\\s+(\\d+)\\s+kB\\s*$`, 'm').exec(
        status
      );
      assert.ok(match?.[1], `missing ${name} for pid ${pid}`);
      const bytes = Number(match[1]) * 1024;
      assert.ok(
        Number.isSafeInteger(bytes) && bytes >= 0,
        `invalid ${name} for pid ${pid}: ${match[1]}`
      );
      return bytes;
    };
    const footprint = fieldBytes('RssAnon') + fieldBytes('VmSwap');
    assert.ok(
      Number.isSafeInteger(footprint),
      `invalid footprint for pid ${pid}`
    );
    return footprint;
  }
  throw new Error(
    `Footprint measurement is unsupported on ${process.platform}`
  );
}

export function memoryGrowth(
  before: MemorySnapshot,
  after: MemorySnapshot
): MemoryGrowth {
  let footprint = 0;
  let rss = 0;
  const added: number[] = [];
  const exited: number[] = [];
  for (const [pid, current] of after) {
    const previous = before.get(pid);
    if (!previous) added.push(pid);
    footprint += current.footprint - (previous?.footprint ?? 0);
    rss += current.rss - (previous?.rss ?? 0);
  }
  for (const pid of before.keys()) {
    if (!after.has(pid)) exited.push(pid);
  }
  return { footprint, rss, added, exited };
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
  // What the page said, kept for a timeout's report: errors and warnings.
  private readonly complaints: string[] = [];

  private constructor(
    readonly child: ChildProcess,
    readonly cdp: CdpConnection,
    readonly downloadDirectory: string,
    // The end of the browser's own stderr, collected since it was spawned.
    private readonly stderr: { tail: string }
  ) {
    this.stopEvents = cdp.onEvent((event) => {
      if (event.method === 'Runtime.exceptionThrown') {
        this.complain(JSON.stringify(event.params['exceptionDetails']));
        return;
      }
      if (event.method === 'Runtime.consoleAPICalled') {
        const type = event.params['type'];
        if (type === 'error' || type === 'warning')
          this.complain(`${type}: ${JSON.stringify(event.params['args'])}`);
        return;
      }
      if (event.method !== 'Browser.downloadProgress') return;
      const guid = event.params['guid'];
      const state = event.params['state'];
      if (typeof guid === 'string' && typeof state === 'string')
        this.downloads.set(guid, state);
    });
  }

  private complain(text: string): void {
    this.complaints.push(text.slice(0, 1000));
    if (this.complaints.length > 20) this.complaints.shift();
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
    // Drained from the start so the owned browser cannot block on a full pipe,
    // and kept so a startup or storage failure can say what the browser printed.
    const stderr = { tail: '' };
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.tail = (stderr.tail + chunk.toString('utf8')).slice(-4096);
    });
    const cdp = connectPipe(
      child.stdio[3] as Writable,
      child.stdio[4] as Readable
    );
    try {
      // This browser starts straight after a 500 MB publish. In CI run
      // 43270214432 it printed its first line 7 s after it was spawned and the
      // default 10 s attestation deadline passed before it answered. The
      // attestation itself is unchanged; only the wait for a slow start is.
      await attestBrowserHeadless(cdp, launch, 60_000);
      await cdp.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: downloads,
        eventsEnabled: true,
      });
      return new ProofBrowser(child, cdp, downloads, stderr);
    } catch (error) {
      cdp.dispose();
      child.kill('SIGKILL');
      if (error instanceof Error)
        error.message = `${error.message}; browser stderr tail=${JSON.stringify(stderr.tail)}`;
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
    await this.cdp.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: BLOB_FAILURE_PRELUDE },
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
    let storageRefused = false;
    while (Date.now() < deadline) {
      value = await this.evaluate<T>(page, expression);
      if (value) return value;
      if (
        this.complaints.some((entry) => entry.includes('LARGE_BLOB_FAILURE'))
      ) {
        storageRefused = await this.evaluate<boolean>(
          page,
          'document.querySelector("main.stage-dead .accession")?.textContent === "content_store_failed"'
        );
        if (storageRefused) break;
      }
      await Bun.sleep(100);
    }
    const text = await this.evaluate<string>(
      page,
      'document.body?.innerText?.slice(0, 4000) ?? ""'
    ).catch(() => 'page unavailable');
    // A page that could not hold the file names no cause. The storage the
    // browser reports, what the page logged and what the browser printed do.
    const storage = await this.evaluate<string>(
      page,
      'navigator.storage.estimate().then((estimate) => JSON.stringify(estimate))'
    ).catch(() => 'unavailable');
    const blobHistograms = await this.cdp
      .send('Browser.getHistograms', { query: 'Storage.Blob' })
      .then((response) => JSON.stringify(response['histograms']))
      .catch(() => 'unavailable');
    let blobInternals = 'not captured';
    if (storageRefused) {
      let internalsPage: Page | undefined;
      try {
        internalsPage = await this.page('chrome://blob-internals/');
        blobInternals = await this.waitFor<string>(
          internalsPage,
          'document.body?.innerText',
          'Blob internals',
          5000
        );
      } catch (error) {
        blobInternals = `unavailable: ${String(error)}`;
      } finally {
        if (internalsPage) await this.closePage(internalsPage);
      }
      // Diagnostic only: the original proof still fails. A streamed Blob initializes
      // Chromium's real quota; its constructor path can retain the 500 MiB default.
      const quotaProbe = await this.evaluate(
        page,
        `(async () => {
        const parent = globalThis.__largeProofFailedParentBlob;
        if (!(parent instanceof Blob) || parent.size <= 1) return { parent: 'unavailable' };
        const readLast = async () => {
          try {
            const bytes = new Uint8Array(await parent.slice(parent.size - 1).arrayBuffer());
            return { ok: true, bytes: [...bytes] };
          } catch (error) { return { ok: false, name: error.name, message: error.message }; }
        };
        const before = await readLast();
        const stream = new ReadableStream({ start(controller) {
          controller.enqueue(new Uint8Array([0]));
          controller.close();
        }});
        const initialized = await new Response(stream).blob();
        const after = await readLast();
        return { parentSize: parent.size, before, initializedSize: initialized.size, after };
      })()`
      ).catch((error) => ({ probeError: String(error) }));
      console.log('LARGE_BLOB_QUOTA_PROBE', JSON.stringify(quotaProbe));
    }
    throw new Error(
      `${storageRefused ? 'storage refused while' : 'timed out'} waiting for ${label}; last=${JSON.stringify(value)}; page=${text}; storage=${storage}; page complaints=${JSON.stringify(this.complaints)}; blob histograms=${blobHistograms}; blob internals=${blobInternals}; browser stderr tail=${JSON.stringify(this.stderr.tail)}`
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

  async rendererMemory(includeUtility = false): Promise<MemorySnapshot> {
    const response = await this.cdp.send('SystemInfo.getProcessInfo');
    const processes = response['processInfo'];
    assert.ok(Array.isArray(processes), 'CDP returned no browser process list');
    const selected = new Map<number, ProcessMemory>();
    let rendererCount = 0;
    for (const entry of processes) {
      if (entry !== null && typeof entry === 'object') {
        if (entry.type === 'renderer') rendererCount++;
        if (
          entry.type === 'renderer' ||
          (includeUtility && entry.type === 'utility')
        ) {
          const pid = entry.id;
          assert.ok(
            typeof pid === 'number' && Number.isInteger(pid) && pid > 0,
            'CDP process has no valid process ID'
          );
          assert.ok(!selected.has(pid), `CDP returned duplicate pid ${pid}`);
          const type = entry.type === 'renderer' ? 'renderer' : 'utility';
          const [footprint, rss] = await Promise.all([
            processFootprintBytes(pid),
            processRssBytes(pid),
          ]);
          selected.set(pid, { type, footprint, rss });
        }
      }
    }
    assert.ok(rendererCount > 0, 'CDP returned no renderer process');
    return selected;
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

  async memoryNegativeControl(page: Page): Promise<{
    allocation: MemoryGrowth;
    retained: MemoryGrowth;
    churn: MemoryGrowth;
  }> {
    assert.equal(
      await this.evaluate<string>(page, 'location.href'),
      'about:blank',
      'memory calibration requires its own blank page'
    );
    await this.pressure(page);
    const allocationBaseline = await this.rendererMemory();
    await this.evaluate(
      page,
      `(() => {
      const bytes = new Uint8Array(512 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 1;
      globalThis.__largeProofAllocation = bytes;
    })()`
    );
    const allocation = memoryGrowth(
      allocationBaseline,
      await this.rendererMemory()
    );
    assert.ok(
      allocation.footprint > 400 * MIB,
      `memory sampler missed 512 MiB allocation: ${JSON.stringify(allocation)}`
    );
    await this.evaluate(page, 'globalThis.__largeProofAllocation = null');
    await this.pressure(page);

    const baseline = await this.rendererMemory();
    await this.evaluate(
      page,
      `(() => {
      const retained = [];
      for (let n = 0; n < 1536; n++) {
        const bytes = new Uint8Array(64 * 1024);
        for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 1;
        retained.push(bytes);
      }
      globalThis.__largeProofRetained = retained;
    })()`
    );
    await this.pressure(page);
    const retained = memoryGrowth(baseline, await this.rendererMemory());
    assert.ok(
      retained.footprint > 64 * MIB,
      `memory sampler missed retained allocations: ${JSON.stringify(retained)}`
    );

    await this.evaluate(
      page,
      `(() => {
      globalThis.__largeProofRetained = null;
      let checksum = 0;
      for (let n = 0; n < 8192; n++) {
        const bytes = new Uint8Array(64 * 1024);
        for (let i = 0; i < bytes.length; i += 4096) bytes[i] = 1;
        checksum += bytes[n % bytes.length];
      }
      globalThis.__largeProofChurnChecksum = checksum;
    })()`
    );
    await this.pressure(page);
    const churn = memoryGrowth(baseline, await this.rendererMemory());
    assert.ok(
      churn.footprint < 64 * MIB,
      `memory sampler counted released churn: ${JSON.stringify(churn)}`
    );
    return { allocation, retained, churn };
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
