import { homedir, tmpdir } from 'node:os';
import { mkdtemp, realpath } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { connectPipe } from '../src/cover/cdp.ts';
import { chromeArgs, launchChrome } from '../src/cover/chrome.ts';
import { resolveProgramBrowser } from '../src/program/browser.ts';
import {
  macosJailProfile,
  createConfinedPaths,
  confinedEnv,
  confinementFlags,
  JAIL_FLAGS,
  launcherFor,
  type ConfinedPaths,
} from '../src/program/confine.ts';
import { verifyJail } from '../src/program/jail-probe.ts';
import {
  createPrivateRamVolume,
  releasePrivateRamVolume,
  run,
} from '../src/program/ramdisk.ts';

// The production launcher adds proxy and resolver guards. This independently
// starts the same shell and Seatbelt profile without those guards, so a network
// denial cannot be attributed to Chrome's proxy or Fetch interception.
async function directNetworkProbe(
  shell: string,
  profile: string,
  paths: ConfinedPaths,
  port: number
) {
  const profileDir = await mkdtemp(join(paths.root, 'network-proof-'));
  const args = chromeArgs(shell, profileDir).filter(
    (arg) =>
      !arg.startsWith('--proxy-server=') &&
      !arg.startsWith('--proxy-bypass-list=') &&
      !arg.startsWith('--host-resolver-rules=')
  );
  const child = spawn(
    '/usr/bin/sandbox-exec',
    [
      '-p',
      profile,
      shell,
      ...args.slice(0, -1),
      ...JAIL_FLAGS,
      ...confinementFlags(paths),
      args[args.length - 1]!,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: confinedEnv(paths),
    }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4096);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  const input = child.stdio[3] as NodeJS.WritableStream;
  const output = child.stdio[4] as NodeJS.ReadableStream;
  const cdp = connectPipe(input, output);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        await cdp.send('Browser.getVersion');
        const target = await cdp.send('Target.createTarget', {
          url: 'about:blank',
        });
        const attached = await cdp.send('Target.attachToTarget', {
          targetId: target['targetId'],
          flatten: true,
        });
        const session = attached['sessionId'];
        if (typeof session !== 'string')
          throw new Error('direct probe has no session');
        return await cdp.send(
          'Page.navigate',
          { url: `http://127.0.0.1:${port}/` },
          session
        );
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`direct browser network probe timed out: ${stderr}`)
            ),
          20000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    cdp.dispose();
    child.kill('SIGKILL');
    await exited;
  }
}

if (process.platform !== 'darwin') throw new Error('macOS required');
const shell = await resolveProgramBrowser(
  process.env['RELIC_OTIO_CHROME_PATH']
);
if (!shell.ok)
  throw new Error(`isolated headless shell unavailable: ${shell.reason}`);
const volume = await createPrivateRamVolume(256);
try {
  const profile = macosJailProfile({
    shell: shell.path,
    ramRoot: volume.mountPoint,
  });
  const jailCheck = await verifyJail({ profile, ramRoot: volume.mountPoint });
  if (!jailCheck.ok)
    throw new Error(`production jail failed: ${jailCheck.reason}`);
  const outside = await realpath(tmpdir());
  for (const weakened of [
    '(allow file-read* (literal "/private/etc/hosts"))',
    '(allow network*)',
    `(allow file-write* (subpath "${outside}"))`,
    '(allow process-exec (literal "/usr/bin/true"))',
    `(allow file-read* (subpath "${await realpath(homedir())}"))`,
  ]) {
    if (
      (
        await verifyJail({
          profile: profile + '\n' + weakened,
          ramRoot: volume.mountPoint,
        })
      ).ok
    )
      throw new Error('weakened jail passed');
  }
  const paths = await createConfinedPaths(volume.mountPoint);
  const launcher = launcherFor(profile);
  if (!launcher) throw new Error('launcher absent');
  const browser = await launchChrome(shell.path, {
    startupTimeoutMs: 10000,
    profileParent: paths.root,
    launcher,
    env: confinedEnv(paths),
    extraArgs: [
      ...JAIL_FLAGS,
      ...confinementFlags(paths),
      '--no-proxy-server',
      '--host-resolver-rules=',
    ],
  });
  const listener = createServer((s) =>
    s.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')
  );
  let connections = 0;
  listener.on('connection', () => connections++);
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string')
      throw new Error('listener missing');
    await new Promise<void>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (connections < 1) throw new Error('listener positive control failed');
    connections = 0;
    const created = await browser.cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const attached = await browser.cdp.send('Target.attachToTarget', {
      targetId: created['targetId'],
      flatten: true,
    });
    const session = attached['sessionId'];
    if (typeof session !== 'string') throw new Error('missing session');
    // WebCodecs requires a secure context. Match the production virtual HTTPS
    // origin, fulfilled from memory, instead of the opaque about:blank target.
    const page = 'https://program.relic.invalid/index.html';
    const removeFetch = browser.cdp.onEvent((event) => {
      if (event.sessionId !== session || event.method !== 'Fetch.requestPaused')
        return;
      const requestId = event.params['requestId'];
      if (typeof requestId !== 'string') return;
      const request = event.params['request'] as { url?: unknown } | undefined;
      if (request?.url === page) {
        void browser.cdp.send(
          'Fetch.fulfillRequest',
          {
            requestId,
            responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'text/html' }],
            body: Buffer.from(
              '<!doctype html><title>codec proof</title>'
            ).toString('base64'),
          },
          session
        );
      } else {
        void browser.cdp.send(
          'Fetch.failRequest',
          { requestId, errorReason: 'BlockedByClient' },
          session
        );
      }
    });
    await browser.cdp.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      session
    );
    await browser.cdp.send('Page.enable', {}, session);
    await Promise.all([
      browser.cdp.waitForEvent('Page.loadEventFired', {
        sessionId: session,
        timeoutMs: 10000,
      }),
      browser.cdp.send('Page.navigate', { url: page }, session),
    ]);
    const codec = await browser.cdp.send(
      'Runtime.evaluate',
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
      const out = {secure:isSecureContext, audio:0, video:0};
      try {
        const a = new AudioEncoder({output:()=>out.audio++,error:e=>{out.audioError=String(e)}});
        a.configure({codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,bitrate:128000});
        for(let i=0;i<10;i++) {
          const data = new AudioData({format:'f32-planar',sampleRate:48000,numberOfFrames:4800,numberOfChannels:2,timestamp:i*100000,data:new Float32Array(9600)});
          a.encode(data); data.close();
        }
        await a.flush(); a.close();
      } catch(e) { out.audioError=String(e); }
      try {
        const v = new VideoEncoder({output:()=>out.video++,error:e=>{out.videoError=String(e)}});
        v.configure({codec:'avc1.42001f',width:1280,height:720,bitrate:2000000,framerate:30,avc:{format:'avc'}});
        const canvas=new OffscreenCanvas(1280,720);
        canvas.getContext('2d').fillRect(0,0,1280,720);
        for(let i=0;i<10;i++) { const frame=new VideoFrame(canvas,{timestamp:i*33333}); v.encode(frame,{keyFrame:i===0}); frame.close(); }
        await v.flush(); v.close();
      } catch(e) { out.videoError=String(e); }
      return out;
    })()`,
      },
      session
    );
    const result = codec['result'] as
      | { value?: { secure?: boolean; audio?: number; video?: number } }
      | undefined;
    if (!result?.value?.secure || !(result.value.audio && result.value.video)) {
      throw new Error(`jailed WebCodecs failed: ${JSON.stringify(codec)}`);
    }
    await browser.cdp.send('Fetch.disable', {}, session);
    removeFetch();
    // Positive control remains inside the jail, adding only outbound access
    // to the listener's loopback port, not general network or host access.
    const loopbackProfile =
      profile +
      `\n(allow network-outbound (remote ip "localhost:${address.port}"))`;
    const positiveNav = await directNetworkProbe(
      shell.path,
      loopbackProfile,
      paths,
      address.port
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (positiveNav['errorText'] || connections < 1) {
      throw new Error(
        `confined browser loopback positive control failed: ${JSON.stringify({ positiveNav, connections })}`
      );
    }
    connections = 0;
    const nav = await directNetworkProbe(
      shell.path,
      profile,
      paths,
      address.port
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (nav['errorText'] !== 'net::ERR_ACCESS_DENIED' || connections !== 0) {
      throw new Error(
        `jailed browser network control failed: ${JSON.stringify({ nav, connections })}`
      );
    }
  } finally {
    listener.close();
    await browser.close();
  }
  const notification = `relic.jail.${randomBytes(12).toString('hex')}`;
  const waiter = spawn('/usr/bin/notifyutil', ['-w', notification], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let observed = '';
  waiter.stdout.on('data', (chunk) => {
    observed += String(chunk);
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const positive = await run('/usr/bin/notifyutil', ['-p', notification]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (positive.code !== 0 || !observed.includes(notification))
      throw new Error('notify positive control failed');
    observed = '';
    const notifyProfile =
      profile +
      '\n(allow process-exec (literal "/usr/bin/notifyutil"))\n(allow file-read* file-map-executable (literal "/usr/bin/notifyutil"))';
    const denied = await run('/usr/bin/sandbox-exec', [
      '-p',
      notifyProfile,
      '/usr/bin/notifyutil',
      '-p',
      notification,
    ]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (
      observed.includes(notification) ||
      !`${denied.stdout}${denied.stderr}`.includes('Failed')
    )
      throw new Error('notify jail control failed');
  } finally {
    waiter.kill('SIGTERM');
  }
  console.log('PROGRAM_JAIL_PATH_OK');
} finally {
  await releasePrivateRamVolume(volume);
}
