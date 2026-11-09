/**
 * Run from repo root: bun packages/relic-mcp/test/otio-direct-audio-experiment.ts
 * Requires installed workspace dependencies, ffmpeg, and a headless Chrome executable
 * discoverable by the repo or named by RELIC_OTIO_CHROME_PATH / RELIC_CHROME_PATH.
 * This is a bounded real-time Web Audio graph experiment, not OTIO player proof.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connectPipe, type CdpConnection } from '../src/cover/cdp.ts';
import { chromeArgs, discoverChrome } from '../src/cover/chrome.ts';
import {
  attestBrowserHeadless,
  createBrowserHeadlessLaunch,
} from './browser-headless.ts';

const testDir = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(
  testDir,
  '../../relic-format/test/fixtures/otio/standard-sample.otiod/media'
);
const paths = [
  join(fixture, 'mx_bed.wav'),
  join(fixture, 'dx_mic1.wav'),
] as const;
function reference(path: string): Uint8Array<ArrayBuffer> {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      path,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `ffmpeg reference failed: ${result.error ?? result.stderr.toString()}`
    );
  if (!result.stdout.length || result.stdout.length % 4)
    throw new Error('invalid ffmpeg PCM');
  return new Uint8Array(result.stdout);
}
const condition = process.env.RELIC_AUDIO_CONDITION ?? 'running';
const guard = process.env.RELIC_AUDIO_GUARD ?? '256';
const hint = process.env.RELIC_AUDIO_HINT ?? 'interactive';
if (
  !['running', 'suspended'].includes(condition) ||
  !['0', '128', '256'].includes(guard) ||
  !['0', 'interactive'].includes(hint)
)
  throw new Error('Invalid audio experiment options');

function videoFrame(frame: number): Uint8Array<ArrayBuffer> {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      resolve(
        testDir,
        '../../relic-format/test/fixtures/otio/decoder-boundary.otiod/media/fr30.webm'
      ),
      '-vf',
      `select=eq(n\\,${frame})`,
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'png',
      'pipe:1',
    ],
    { maxBuffer: 4 * 1024 * 1024 }
  );
  if (result.error || result.status !== 0 || !result.stdout.length)
    throw new Error(
      `ffmpeg video frame failed: ${result.error ?? result.stderr.toString()}`
    );
  return new Uint8Array(result.stdout);
}

async function main() {
  const found = await discoverChrome(
    process.env.RELIC_OTIO_CHROME_PATH ?? process.env.RELIC_CHROME_PATH
  );
  if (found.kind !== 'found')
    throw new Error(`Chrome unavailable: ${found.kind}`);
  const bundle = await Bun.build({
    entrypoints: [join(testDir, 'otio-direct-audio-browser.ts')],
    target: 'browser',
    format: 'iife',
  });
  if (!bundle.success)
    throw new Error(`Browser bundle failed: ${bundle.logs.join('\n')}`);
  const output = bundle.outputs[0];
  if (!output) throw new Error('Browser bundle has no output');
  const script = await output.text();
  const bed = await Bun.file(paths[0]).arrayBuffer();
  const dialog = await Bun.file(paths[1]).arrayBuffer();
  const refs = [reference(paths[0]), reference(paths[1])] as const;
  const data = new Map<
    string,
    { body: ArrayBuffer | Uint8Array<ArrayBuffer>; type: string }
  >([
    ['/bed.wav', { body: bed, type: 'audio/wav' }],
    ['/dialog.wav', { body: dialog, type: 'audio/wav' }],
    ['/bed.f32', { body: refs[0], type: 'application/octet-stream' }],
    ['/dialog.f32', { body: refs[1], type: 'application/octet-stream' }],
    ['/frame0.png', { body: videoFrame(0), type: 'image/png' }],
    ['/frame1.png', { body: videoFrame(1), type: 'image/png' }],
  ]);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/')
        return new Response(
          '<!doctype html><meta charset="utf-8"><script src="/experiment.js"></script>',
          { headers: { 'content-type': 'text/html' } }
        );
      if (url.pathname === '/experiment.js')
        return new Response(script, {
          headers: { 'content-type': 'text/javascript' },
        });
      const item = data.get(url.pathname);
      if (!item) return new Response('not found', { status: 404 });
      const bytes =
        item.body instanceof Uint8Array ? item.body : new Uint8Array(item.body);
      const range = request.headers.get('range');
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match)
          return new Response(null, {
            status: 416,
            headers: { 'content-range': `bytes */${bytes.length}` },
          });
        const start = Number(match[1]);
        const end = Math.min(
          match[2] ? Number(match[2]) : bytes.length - 1,
          bytes.length - 1
        );
        if (start > end || start >= bytes.length)
          return new Response(null, {
            status: 416,
            headers: { 'content-range': `bytes */${bytes.length}` },
          });
        return new Response(bytes.slice(start, end + 1), {
          status: 206,
          headers: {
            'content-type': item.type,
            'accept-ranges': 'bytes',
            'content-range': `bytes ${start}-${end}/${bytes.length}`,
            'content-length': String(end - start + 1),
          },
        });
      }
      return new Response(bytes, {
        headers: {
          'content-type': item.type,
          'content-length': String(bytes.length),
          'accept-ranges': 'bytes',
        },
      });
    },
  });
  const profile = await mkdtemp(join(tmpdir(), 'otio-direct-audio-'));
  let child: ChildProcess | undefined;
  let cdp: CdpConnection | undefined;
  try {
    const args = chromeArgs(found.path, profile)
      .filter((arg) => arg !== '--mute-audio')
      .map((arg) =>
        arg === '--proxy-bypass-list=<-loopback>'
          ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
          : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
            ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
            : arg
      );
    const launch = createBrowserHeadlessLaunch(
      condition === 'running'
        ? [...args, '--autoplay-policy=no-user-gesture-required']
        : args,
      profile
    );
    child = spawn(found.path, launch.args, {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    });
    assert.ok(
      child.stdio[3] instanceof Writable && child.stdio[4] instanceof Readable,
      'missing Chrome pipes'
    );
    cdp = connectPipe(child.stdio[3], child.stdio[4]);
    const attestation = await attestBrowserHeadless(cdp, launch);
    const target = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await cdp.send('Target.attachToTarget', {
      targetId: target.targetId,
      flatten: true,
    });
    const session = String(attached.sessionId);
    await cdp.send('Page.enable', {}, session);
    await cdp.send('Runtime.enable', {}, session);
    const loaded = cdp.waitForEvent('Page.loadEventFired', {
      sessionId: session,
      timeoutMs: 15000,
    });
    await cdp.send(
      'Page.navigate',
      {
        url: `http://127.0.0.1:${server.port}/?condition=${condition}&guard=${guard}&hint=${hint}`,
      },
      session
    );
    await loaded;
    let baselineResult: unknown =
      'skipped for suspended trusted-input condition';
    if (condition === 'running') {
      const result = await cdp.send(
        'Runtime.evaluate',
        {
          expression: 'globalThis.runDirectAudio()',
          awaitPromise: true,
          returnByValue: true,
          timeout: 20000,
        },
        session
      );
      if (result.exceptionDetails)
        throw new Error(
          `Browser experiment failed: ${JSON.stringify(result.exceptionDetails)}`
        );
      const remote = result.result as { value?: unknown };
      if (!remote.value)
        throw new Error(`Missing browser result: ${JSON.stringify(result)}`);
      baselineResult = remote.value;
    }
    const screenshots: { data: string; timestamp: number }[] = [];
    const connection = cdp;
    const unsubscribe = connection.onEvent((event) => {
      if (
        event.method !== 'Page.screencastFrame' ||
        event.sessionId !== session
      )
        return;
      const meta = event.params.metadata as { timestamp?: number } | undefined;
      if (
        typeof event.params.data === 'string' &&
        typeof meta?.timestamp === 'number'
      )
        screenshots.push({
          data: event.params.data,
          timestamp: meta.timestamp,
        });
      void connection.send(
        'Page.screencastFrameAck',
        { sessionId: event.params.sessionId },
        session
      );
    });
    await connection.send(
      'Page.startScreencast',
      { format: 'png', everyNthFrame: 1 },
      session
    );
    let cold: Record<string, unknown>;
    if (condition === 'suspended') {
      await connection.send(
        'Runtime.evaluate',
        {
          expression:
            'globalThis.coldPromise = globalThis.runIdealCold(); void 0',
        },
        session
      );
      const ready = await connection.send(
        'Runtime.evaluate',
        {
          expression: `new Promise((resolve,reject) => { const t=Date.now(); const poll=()=>{if(globalThis.coldReady) resolve(true); else if(Date.now()-t>10000) reject(new Error('button not ready')); else setTimeout(poll,10)};poll() })`,
          awaitPromise: true,
          returnByValue: true,
        },
        session
      );
      if (ready.exceptionDetails)
        throw new Error(
          `Trusted click setup failed: ${JSON.stringify(ready.exceptionDetails)}`
        );
      await connection.send(
        'Input.dispatchMouseEvent',
        { type: 'mousePressed', x: 690, y: 25, button: 'left', clickCount: 1 },
        session
      );
      await connection.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseReleased', x: 690, y: 25, button: 'left', clickCount: 1 },
        session
      );
      cold = await connection.send(
        'Runtime.evaluate',
        {
          expression: 'globalThis.coldPromise',
          awaitPromise: true,
          returnByValue: true,
          timeout: 20000,
        },
        session
      );
    } else {
      cold = await connection.send(
        'Runtime.evaluate',
        {
          expression: 'globalThis.runIdealCold()',
          awaitPromise: true,
          returnByValue: true,
          timeout: 20000,
        },
        session
      );
    }
    await connection.send('Page.stopScreencast', {}, session);
    unsubscribe();
    if (cold.exceptionDetails)
      throw new Error(
        `Ideal cold experiment failed: ${JSON.stringify(cold.exceptionDetails)}`
      );
    const coldValue = (cold.result as { value?: Record<string, unknown> })
      .value;
    if (!coldValue) throw new Error('Missing ideal cold result');
    const classify = `(async () => {
      const input = ${JSON.stringify(screenshots)};
      const originals = await Promise.all(['/frame0.png','/frame1.png'].map(async url => createImageBitmap(await (await fetch(url)).blob())));
      const canvas = document.createElement('canvas'); canvas.width=640; canvas.height=160;
      const ctx=canvas.getContext('2d',{willReadFrequently:true}); ctx.imageSmoothingEnabled=false;
      const expected=originals.map(im => {ctx.clearRect(0,0,640,160);ctx.drawImage(im,0,0,640,160); return ctx.getImageData(0,0,640,160).data;});
      const results=[];
      for (const frame of input) {
        const image=await createImageBitmap(await (await fetch('data:image/png;base64,'+frame.data)).blob());
        ctx.clearRect(0,0,640,160);ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,640,160).data;
        let errors=[0,0]; for(let i=0;i<pixels.length;i+=4) for(let channel=0;channel<3;channel++) for(let j=0;j<2;j++) errors[j]+=Math.abs(pixels[i+channel]-expected[j][i+channel]);
        results.push({ timestamp:frame.timestamp, errors, match: errors[1]<errors[0] ? 1 : 0 }); image.close();
      }
      originals.forEach(im=>im.close()); return results;
    })()`;
    const classified = await connection.send(
      'Runtime.evaluate',
      { expression: classify, awaitPromise: true, returnByValue: true },
      session
    );
    if (classified.exceptionDetails)
      throw new Error(
        `Screencast classification failed: ${JSON.stringify(classified.exceptionDetails)}`
      );
    const captured = (
      classified.result as {
        value?: { timestamp: number; errors: number[]; match: number }[];
      }
    ).value;
    if (!captured?.length) throw new Error('No screencast frames captured');
    const requestWallMs =
      Number(coldValue.performanceTimeOrigin) + Number(coldValue.request);
    const firstChanged = captured.find(
      (frame) => frame.match === 1 && frame.timestamp * 1000 >= requestWallMs
    );
    const baseline = captured.find(
      (frame) => frame.match === 0 && frame.errors[0] === 0
    );
    if (
      !baseline ||
      !firstChanged ||
      firstChanged.errors[1] !== 0 ||
      firstChanged.errors[0] === 0
    )
      throw new Error(
        `Screencast frame controls failed: ${JSON.stringify(captured)}`
      );
    const coldResult = {
      ...coldValue,
      screencastFrames: captured,
      firstChangedScreencastAfterRequestMs:
        firstChanged.timestamp * 1000 - requestWallMs,
      gates: {
        singleRunMaximum100ms:
          firstChanged.timestamp * 1000 - requestWallMs <= 100,
        p95_50ms: 'unqualified: one trial',
      },
    };
    const root = resolve(testDir, '../../..');
    const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    });
    const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: root });
    if (revision.status !== 0 || diff.status !== 0)
      throw new Error('Cannot fingerprint repository');
    const digest = (bytes: Uint8Array) =>
      createHash('sha256').update(bytes).digest('hex');
    const sources = await Promise.all(
      ['otio-direct-audio-browser.ts', 'otio-direct-audio-experiment.ts'].map(
        async (name) => ({
          name,
          sha256: digest(
            new Uint8Array(await Bun.file(join(testDir, name)).arrayBuffer())
          ),
        })
      )
    );
    const report = {
      revision: revision.stdout.trim(),
      worktreeDiffSha256: digest(diff.stdout),
      sources,
      fixtureSha256: {
        bed: digest(new Uint8Array(bed)),
        dialog: digest(new Uint8Array(dialog)),
        frame0: digest(videoFrame(0)),
        frame1: digest(videoFrame(1)),
      },
      browser: attestation.version,
      browserArguments: attestation.arguments,
      reference: 'ffmpeg decoded fixture PCM f32le 48000 Hz mono',
      result: baselineResult,
      idealCold: coldResult,
      rawScreencast: screenshots,
    };
    const receipt =
      process.env.RELIC_AUDIO_RECEIPT ??
      join(
        tmpdir(),
        `otio-audio-${condition}-${guard}-${hint}-${Date.now()}.json`
      );
    await Bun.write(receipt, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ receipt, idealCold: coldResult }, null, 2));
  } finally {
    cdp?.dispose();
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) =>
        child?.once('exit', () => resolveExit())
      );
      child.kill();
      await Promise.race([exited, Bun.sleep(3000)]);
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    }
    server.stop(true);
    await rm(profile, { recursive: true, force: true });
  }
}
try {
  await main();
} catch (error) {
  const root = resolve(testDir, '../../..');
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  });
  const diff = spawnSync('git', ['diff', '--binary', 'HEAD'], { cwd: root });
  const sources = await Promise.all(
    ['otio-direct-audio-browser.ts', 'otio-direct-audio-experiment.ts'].map(
      async (name) => ({
        name,
        sha256: createHash('sha256')
          .update(
            new Uint8Array(await Bun.file(join(testDir, name)).arrayBuffer())
          )
          .digest('hex'),
      })
    )
  );
  const receipt =
    process.env.RELIC_AUDIO_RECEIPT ??
    join(
      tmpdir(),
      `otio-audio-${condition}-${guard}-${hint}-${Date.now()}-failure.json`
    );
  await Bun.write(
    receipt,
    JSON.stringify(
      {
        status: 'failure',
        condition,
        guard,
        hint,
        revision: revision.stdout.trim(),
        worktreeDiffSha256: createHash('sha256')
          .update(diff.stdout)
          .digest('hex'),
        sources,
        error: String(error),
      },
      null,
      2
    )
  );
  console.error(`Failure receipt: ${receipt}`);
  throw error;
}
