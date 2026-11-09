/**
 * Run from repo root: bun packages/relic-mcp/test/otio-direct-audio-experiment.ts
 * Requires installed workspace dependencies, ffmpeg, and a headless Chrome executable
 * discoverable by the repo or named by RELIC_OTIO_CHROME_PATH / RELIC_CHROME_PATH.
 * This is a bounded real-time Web Audio graph experiment, not OTIO player proof.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
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
    const args = chromeArgs(found.path, profile).map((arg) =>
      arg === '--proxy-bypass-list=<-loopback>'
        ? '--proxy-bypass-list=<-loopback>;127.0.0.1'
        : arg === '--host-resolver-rules=MAP * ~NOTFOUND'
          ? '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'
          : arg
    );
    const launch = createBrowserHeadlessLaunch(
      [...args, '--autoplay-policy=no-user-gesture-required'],
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
      { url: `http://127.0.0.1:${server.port}/` },
      session
    );
    await loaded;
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
    console.log(
      JSON.stringify(
        {
          browser: attestation.version,
          reference: 'ffmpeg decoded fixture PCM f32le 48000 Hz mono',
          result: remote.value,
        },
        null,
        2
      )
    );
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
await main();
