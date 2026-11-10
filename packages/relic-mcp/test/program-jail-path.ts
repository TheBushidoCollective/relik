import { homedir, tmpdir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { launchChrome } from '../src/cover/chrome.ts';
import { resolveProgramBrowser } from '../src/program/browser.ts';
import {
  macosJailProfile,
  createConfinedPaths,
  confinedEnv,
  confinementFlags,
  JAIL_FLAGS,
  launcherFor,
} from '../src/program/confine.ts';
import { verifyJail } from '../src/program/jail-probe.ts';
import {
  createPrivateRamVolume,
  releasePrivateRamVolume,
  run,
} from '../src/program/ramdisk.ts';

if (process.platform !== 'darwin') throw new Error('macOS required');
const shell = await resolveProgramBrowser(
  process.env['RELIC_OTIO_CHROME_PATH']
);
if (!shell.ok) throw new Error('isolated headless shell required');
const volume = await createPrivateRamVolume(256);
try {
  const profile = macosJailProfile({
    shell: shell.path,
    ramRoot: volume.mountPoint,
  });
  if (!(await verifyJail({ profile, ramRoot: volume.mountPoint })).ok)
    throw new Error('production jail failed');
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
    const codec = await browser.cdp.send(
      'Runtime.evaluate',
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
      let audio = 0, video = 0;
      const a = new AudioEncoder({output:()=>audio++,error:e=>{throw e}});
      a.configure({codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,bitrate:128000});
      const data = new AudioData({format:'f32-planar',sampleRate:48000,numberOfFrames:1024,numberOfChannels:2,timestamp:0,data:new Float32Array(2048)});
      for(let i=0;i<8;i++) a.encode(data); await a.flush(); data.close(); a.close();
      const v = new VideoEncoder({output:()=>video++,error:e=>{throw e}});
      v.configure({codec:'avc1.42001f',width:64,height:64,bitrate:200000,framerate:30});
      const frame = new VideoFrame(new OffscreenCanvas(64,64),{timestamp:0});
      v.encode(frame,{keyFrame:true}); await v.flush(); frame.close(); v.close();
      return audio>0 && video>0;
    })()`,
      },
      session
    );
    const result = codec['result'] as { value?: unknown } | undefined;
    if (result?.value !== true) throw new Error('jailed WebCodecs failed');
    const nav = await browser.cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${address.port}/` },
      session
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (nav['errorText'] !== 'net::ERR_ACCESS_DENIED' || connections !== 0)
      throw new Error('jailed browser network control failed');
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
