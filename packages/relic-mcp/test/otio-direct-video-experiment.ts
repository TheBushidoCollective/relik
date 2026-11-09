/**
 * Proof only. Run from the repository root:
 * RELIC_CHROME_PATH=/path/to/chrome-headless-shell bun packages/relic-mcp/test/otio-direct-video-experiment.ts
 * Requires Bun, ffmpeg, ffprobe, installed workspace dependencies and the committed decoder-boundary fixture.
 * No production server, relay, media mutation, or live system is used.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectPipe, type CdpConnection } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  cleanupOwnedBrowserStartup,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const here = dirname(fileURLToPath(import.meta.url));
const mediaDir = resolve(
  here,
  '../../relic-format/test/fixtures/otio/decoder-boundary.otiod/media'
);
const frameBytes = 64 * 16 * 4;
const tolerance = 0.000002;
type Captured = { timestamp: number; duration: number; pixels: string };
type Result = {
  codec: string;
  config: object;
  key: object;
  packets: { timestamp: number; sequenceNumber: number; type: string }[];
  sequential: Captured[];
  explicit: (Captured & { time: number; latencyMs: number })[];
  sequentialMs: number;
  counts: object;
};

function command(exe: string, args: string[]): Buffer {
  const result = spawnSync(exe, args, { maxBuffer: 128 * 1024 * 1024 });
  if (result.error || result.status !== 0)
    throw new Error(
      `${exe} failed: ${result.error ?? result.stderr.toString()}`
    );
  return result.stdout;
}
function distance(a: Uint8Array, b: Uint8Array): number {
  assert.equal(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < a.length; i += 4)
    for (let c = 0; c < 3; c++) sum += (a[i + c]! - b[i + c]!) ** 2;
  return Math.sqrt(sum / ((a.length / 4) * 3));
}
function frameAt(starts: number[], t: number): number {
  for (let i = starts.length - 2; i >= 0; i--)
    if (t >= starts[i]! && t < starts[i + 1]!) return i;
  return -1;
}
function checkSample(
  sample: Captured,
  expected: number,
  starts: number[],
  refs: Buffer
): { index: number; error: number; margin: number } {
  assert.ok(
    expected >= 0 && expected < starts.length - 1,
    'no independently certified packet window'
  );
  assert.ok(
    Math.abs(sample.timestamp - starts[expected]!) <= tolerance,
    `timestamp ${sample.timestamp} disagrees with packet PTS ${starts[expected]}`
  );
  const pixels = Buffer.from(sample.pixels, 'base64');
  assert.equal(pixels.length, frameBytes);
  const scores = starts
    .map((_, index) => ({
      index,
      error: distance(
        pixels,
        refs.subarray(index * frameBytes, (index + 1) * frameBytes)
      ),
    }))
    .sort((a, b) => a.error - b.error);
  assert.equal(
    scores[0]!.index,
    expected,
    `pixels select frame ${scores[0]!.index}, expected ${expected}`
  );
  assert.ok(
    scores[0]!.error <= 15,
    `pixel RMSE ${scores[0]!.error} exceeds 15`
  );
  const margin = scores[1]!.error - scores[0]!.error;
  assert.ok(margin >= 2, `ambiguous pixels, margin ${margin}`);
  return { index: expected, error: scores[0]!.error, margin };
}

async function main() {
  const executable = process.env.RELIC_CHROME_PATH;
  assert.ok(
    executable && executable.includes('headless'),
    'set RELIC_CHROME_PATH to an owned chrome-headless-shell executable'
  );
  const browser = await discoverChrome(executable);
  assert.equal(browser.kind, 'found', 'headless shell executable unavailable');
  if (browser.kind !== 'found') throw new Error('headless shell unavailable');
  const build = await Bun.build({
    entrypoints: [join(here, 'otio-direct-video-browser.ts')],
    target: 'browser',
    format: 'esm',
    write: false,
  });
  if (!build.success || !build.outputs[0])
    throw new Error(`browser bundle failed: ${build.logs.join('\n')}`);
  const bundle = await build.outputs[0].text();
  const files = new Map<string, Uint8Array>();
  for (const name of ['fr30.webm', 'fr24b.mp4'])
    files.set(name, await readFile(join(mediaDir, name)));
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.hostname !== '127.0.0.1')
        return new Response('forbidden', { status: 403 });
      if (url.pathname === '/')
        return new Response(
          '<!doctype html><meta charset="utf-8"><script type="module" src="/bundle.js"></script>',
          { headers: { 'content-type': 'text/html' } }
        );
      if (url.pathname === '/bundle.js')
        return new Response(bundle, {
          headers: { 'content-type': 'text/javascript' },
        });
      const name = url.pathname.slice('/media/'.length);
      const file = url.pathname.startsWith('/media/')
        ? files.get(name)
        : undefined;
      return file
        ? new Response(file)
        : new Response('not found', { status: 404 });
    },
  });
  const temp = await mkdtemp(join(tmpdir(), 'relic-direct-video-'));
  let child: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  try {
    const profile = join(temp, 'profile');
    const args = chromeArgs(browser.path, profile).map((arg) =>
      arg === '--host-resolver-rules=MAP * ~NOTFOUND'
        ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
        : arg === '--proxy-bypass-list=<-loopback>'
          ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
          : arg
    );
    const launch = createBrowserHeadlessLaunch(args, profile);
    child = spawn(browser.path, launch.args, {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    const to = child.stdio[3],
      from = child.stdio[4];
    assert.ok(
      to instanceof Writable && from instanceof Readable,
      'CDP pipes unavailable'
    );
    cdp = connectPipe(to, from);
    const attestation = await attestBrowserHeadless(cdp, launch);
    const created = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: created.targetId,
      flatten: true,
    });
    assert.equal(typeof attached.sessionId, 'string');
    const session = attached.sessionId;
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    await cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*' }] },
      session
    );
    const active = cdp;
    active.onEvent((event) => {
      if (event.method !== 'Fetch.requestPaused' || event.sessionId !== session)
        return;
      const requestId = event.params.requestId;
      const request = event.params.request as { url?: string } | undefined;
      if (typeof requestId !== 'string') return;
      let allowed = false;
      try {
        const u = new URL(request?.url ?? '');
        allowed =
          u.protocol === 'http:' &&
          u.hostname === '127.0.0.1' &&
          u.port === String(server.port);
      } catch {
        /* deny */
      }
      void active
        .send(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed
            ? { requestId }
            : { requestId, errorReason: 'BlockedByClient' },
          session
        )
        .catch(() => {});
    });
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${server.port}/` },
      session
    );
    const evaluate = async <T>(expression: string): Promise<T> => {
      const result = await active.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true, timeout: 60000 },
        session
      );
      if (result.exceptionDetails)
        throw new Error(
          `browser evaluation: ${JSON.stringify(result.exceptionDetails)}`
        );
      const value = result.result as { value?: T } | undefined;
      assert.ok(value && 'value' in value, 'browser returned no value');
      return value.value as T;
    };
    await evaluate(
      `(async()=>{for(let i=0;i<500;i++){if(typeof globalThis.runDirectVideoExperiment==='function')return true;await new Promise(r=>setTimeout(r,20));}throw Error('bundle did not load')})()`
    );
    const reports = [];
    for (const name of files.keys()) {
      const path = join(mediaDir, name);
      const parsed: {
        frames: { best_effort_timestamp_time?: string; pict_type?: string }[];
      } = JSON.parse(
        command('ffprobe', [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-show_frames',
          '-show_entries',
          'frame=best_effort_timestamp_time,pict_type',
          '-of',
          'json',
          path,
        ]).toString()
      );
      const starts = parsed.frames.map((f) =>
        Number(f.best_effort_timestamp_time)
      );
      assert.ok(
        starts.length > 12 && starts.every(Number.isFinite),
        'invalid ffprobe frame PTS'
      );
      assert.ok(
        starts.every((t, i) => i === 0 || t > starts[i - 1]!),
        'non-increasing frame PTS'
      );
      const refs = command('ffmpeg', [
        '-v',
        'error',
        '-i',
        path,
        '-vf',
        'scale=64:16:flags=neighbor',
        '-fps_mode',
        'passthrough',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgba',
        'pipe:1',
      ]);
      assert.equal(
        refs.length,
        starts.length * frameBytes,
        'ffmpeg frame count differs from ffprobe'
      );
      const probes =
        name === 'fr30.webm'
          ? [0.0666666666667, 0.067, 0.133, 0.2, 0.333 - 0.000003, 0.333, 0.334]
          : [0.105, 0.13, 0.18, 0.22, 0.3];
      const result = await evaluate<Result>(
        `globalThis.runDirectVideoExperiment(${JSON.stringify(name)},${JSON.stringify(probes)})`
      );
      const verified = result.explicit.map((sample) => ({
        time: sample.time,
        latencyMs: sample.latencyMs,
        ...checkSample(sample, frameAt(starts, sample.time), starts, refs),
      }));
      const sequential = result.sequential.map((sample) => {
        const index = starts.findIndex(
          (t) => Math.abs(sample.timestamp - t) <= tolerance
        );
        return checkSample(sample, index, starts, refs);
      });
      assert.ok(sequential.length >= 5, 'too few sequential samples');
      const sample = result.explicit[0]!;
      assert.throws(
        () =>
          checkSample(sample, frameAt(starts, sample.time) + 1, starts, refs),
        'shifted window false control passed'
      );
      assert.equal(frameAt(starts, starts[1]! - 0.000003), 0);
      assert.equal(frameAt(starts, starts[1]!), 1);
      assert.equal(frameAt(starts, starts[starts.length - 1]!), -1);
      const reordered = result.packets.some(
        (p, i) => i > 0 && p.timestamp < result.packets[i - 1]!.timestamp
      );
      if (name === 'fr24b.mp4')
        assert.ok(
          reordered && parsed.frames.some((f) => f.pict_type === 'B'),
          'B-frame fixture does not demonstrate reordering'
        );
      reports.push({
        name,
        codec: result.codec,
        config: result.config,
        key: result.key,
        reordered,
        sequential,
        sequentialMs: result.sequentialMs,
        verified,
        counts: result.counts,
        controls:
          'shifted identity rejected; half-open edges and unknown end rejected',
      });
    }
    console.log(
      JSON.stringify(
        {
          browser: attestation.version,
          reports,
          limitations: [
            'Mediabunny internal prefetch depth and resource release are not instrumented',
            'No compositor deadline, OTIO rational mapping, audio continuity, or production playback is proven',
            'No physical presentation or sustained load qualification',
          ],
        },
        null,
        2
      )
    );
  } finally {
    if (child)
      await cleanupOwnedBrowserStartup({
        child,
        connection: cdp,
        forgetChild: undefined,
        profile: join(temp, 'profile'),
        removeProfile: undefined,
      });
    server.stop(true);
    await rm(temp, { recursive: true, force: true });
  }
}
await main();
