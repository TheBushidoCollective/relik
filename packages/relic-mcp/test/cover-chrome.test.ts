import { describe, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ChromeLaunchError,
  chromeArgs,
  type DiscoverySystem,
  discoverChrome,
  launchChrome,
} from '../src/cover/chrome.ts';

describe('chromeArgs', () => {
  test('matches exact pinned arguments list for standard browser', () => {
    const binary =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const profileDir = '/tmp/relic-chrome-test';
    const args = chromeArgs(binary, profileDir);

    const expected = [
      '--headless=new',
      '--remote-debugging-pipe',
      '--user-data-dir=/tmp/relic-chrome-test',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-domain-reliability',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--metrics-recording-only',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--use-mock-keychain',
      '--password-store=basic',
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--proxy-server=http://proxy.relic.invalid:1',
      '--proxy-bypass-list=<-loopback>',
      '--webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--disable-quic',
      'about:blank',
    ];

    expect(args).toEqual(expected);
    expect(args).not.toContain('--no-sandbox');
    expect(args).not.toContain('--force-webrtc-ip-handling-policy');
  });

  test('uses --headless for chrome-headless-shell binary', () => {
    const binary = '/usr/local/bin/chrome-headless-shell';
    const args = chromeArgs(binary, '/tmp/profile');
    expect(args[0]).toBe('--headless');
    expect(args[1]).toBe('--remote-debugging-pipe');
  });
});

describe('discoverChrome', () => {
  function makeSys(opts: {
    platform: NodeJS.Platform;
    homedir?: string;
    env?: Record<string, string | undefined>;
    executables?: string[];
  }): DiscoverySystem {
    const execSet = new Set(opts.executables ?? []);
    return {
      platform: opts.platform,
      homedir: opts.homedir ?? '/home/testuser',
      env: opts.env ?? {},
      isExecutable: async (filePath: string) => execSet.has(filePath),
    };
  }

  describe('explicit overrides and RELIC_CHROME_PATH', () => {
    test('returns disabled when override is none or disabled', async () => {
      const sys = makeSys({ platform: 'darwin' });
      const res1 = await discoverChrome('none', sys);
      expect(res1.kind).toBe('disabled');
      if (res1.kind === 'disabled') {
        expect(res1.detail).toContain('chromePath is none');
      }

      const res2 = await discoverChrome('disabled', sys);
      expect(res2.kind).toBe('disabled');
      if (res2.kind === 'disabled') {
        expect(res2.detail).toContain('chromePath is disabled');
      }
    });

    test('returns disabled when RELIC_CHROME_PATH is none or disabled', async () => {
      const sys1 = makeSys({
        platform: 'darwin',
        env: { RELIC_CHROME_PATH: 'none' },
      });
      const res1 = await discoverChrome(undefined, sys1);
      expect(res1.kind).toBe('disabled');
      if (res1.kind === 'disabled') {
        expect(res1.detail).toContain('RELIC_CHROME_PATH is none');
      }

      const sys2 = makeSys({
        platform: 'darwin',
        env: { RELIC_CHROME_PATH: 'disabled' },
      });
      const res2 = await discoverChrome(undefined, sys2);
      expect(res2.kind).toBe('disabled');
      if (res2.kind === 'disabled') {
        expect(res2.detail).toContain('RELIC_CHROME_PATH is disabled');
      }
    });

    test('returns found source env when override is executable', async () => {
      const sys = makeSys({
        platform: 'darwin',
        executables: ['/opt/my-chrome'],
      });
      const res = await discoverChrome('/opt/my-chrome', sys);
      expect(res).toEqual({
        kind: 'found',
        path: '/opt/my-chrome',
        source: 'env',
      });
    });

    test('returns found source env when RELIC_CHROME_PATH is executable', async () => {
      const sys = makeSys({
        platform: 'darwin',
        env: { RELIC_CHROME_PATH: '/custom/bin/chrome' },
        executables: ['/custom/bin/chrome'],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: '/custom/bin/chrome',
        source: 'env',
      });
    });

    test('bad override does not continue discovery', async () => {
      // Even if Google Chrome exists in default location, bad explicit path fails immediately
      const sys = makeSys({
        platform: 'darwin',
        executables: [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ],
      });
      const res = await discoverChrome('/nonexistent/chrome', sys);
      expect(res.kind).toBe('not_found');
      if (res.kind === 'not_found') {
        expect(res.detail).toBe(
          'RELIC_CHROME_PATH points at /nonexistent/chrome, which is not an executable file'
        );
        expect(res.searched).toEqual(['/nonexistent/chrome']);
      }
    });

    test('bad RELIC_CHROME_PATH does not continue discovery', async () => {
      const sys = makeSys({
        platform: 'darwin',
        env: { RELIC_CHROME_PATH: '/invalid/env/chrome' },
        executables: [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res.kind).toBe('not_found');
      if (res.kind === 'not_found') {
        expect(res.detail).toBe(
          'RELIC_CHROME_PATH points at /invalid/env/chrome, which is not an executable file'
        );
        expect(res.searched).toEqual(['/invalid/env/chrome']);
      }
    });
  });

  describe('darwin discovery order', () => {
    const chromeDefault =
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chromeUser =
      '/Users/alice/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const chromiumDefault =
      '/Applications/Chromium.app/Contents/MacOS/Chromium';
    const edgeDefault =
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
    const canaryDefault =
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary';

    test('finds default Chrome on Darwin', async () => {
      const sys = makeSys({
        platform: 'darwin',
        homedir: '/Users/alice',
        executables: [chromeDefault],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: chromeDefault,
        source: 'default',
      });
    });

    test('finds user-homedir Chrome on Darwin', async () => {
      const sys = makeSys({
        platform: 'darwin',
        homedir: '/Users/alice',
        executables: [chromeUser],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: chromeUser,
        source: 'default',
      });
    });

    test('finds Edge on Darwin', async () => {
      const sys = makeSys({
        platform: 'darwin',
        homedir: '/Users/alice',
        executables: [edgeDefault],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: edgeDefault,
        source: 'default',
      });
    });

    test('finds chromium in PATH on Darwin when defaults are absent', async () => {
      const sys = makeSys({
        platform: 'darwin',
        homedir: '/Users/alice',
        env: { PATH: '/usr/local/bin:/usr/bin' },
        executables: ['/usr/local/bin/chromium'],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: '/usr/local/bin/chromium',
        source: 'path',
      });
    });

    test('reports not_found with searched list when nothing found on Darwin', async () => {
      const sys = makeSys({
        platform: 'darwin',
        homedir: '/Users/alice',
        env: { PATH: '/usr/bin' },
        executables: [],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res.kind).toBe('not_found');
      if (res.kind === 'not_found') {
        expect(res.searched).toEqual([
          chromeDefault,
          chromeUser,
          chromiumDefault,
          edgeDefault,
          canaryDefault,
          'chrome-headless-shell',
          'chromium',
        ]);
        expect(res.detail).toContain('No Chrome, Chromium, or Edge was found');
        expect(res.detail).toContain(
          'Set RELIC_CHROME_PATH to one to render covers.'
        );
      }
    });
  });

  describe('linux discovery order', () => {
    test('finds google-chrome-stable in PATH first on Linux', async () => {
      const sys = makeSys({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        executables: [
          '/usr/bin/google-chrome-stable',
          '/usr/bin/google-chrome',
        ],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: '/usr/bin/google-chrome-stable',
        source: 'path',
      });
    });

    test('finds default /opt/google/chrome/chrome on Linux when PATH entries absent', async () => {
      const sys = makeSys({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        executables: ['/opt/google/chrome/chrome'],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: '/opt/google/chrome/chrome',
        source: 'default',
      });
    });

    test('reports not_found with searched list when absent on Linux', async () => {
      const sys = makeSys({
        platform: 'linux',
        env: { PATH: '/usr/bin' },
        executables: [],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res.kind).toBe('not_found');
      if (res.kind === 'not_found') {
        expect(res.searched).toEqual([
          'google-chrome-stable',
          'google-chrome',
          'chromium',
          'chromium-browser',
          'microsoft-edge-stable',
          'microsoft-edge',
          'chrome-headless-shell',
          '/opt/google/chrome/chrome',
          '/snap/bin/chromium',
        ]);
      }
    });
  });

  describe('win32 discovery order', () => {
    test('finds default Chrome on win32', async () => {
      const sys = makeSys({
        platform: 'win32',
        env: {
          PROGRAMFILES: 'C:\\Program Files',
        },
        executables: [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        ],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        source: 'default',
      });
    });

    test('finds Edge on win32 via ProgramFiles(x86)', async () => {
      const sys = makeSys({
        platform: 'win32',
        env: {
          'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
        },
        executables: [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        ],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        source: 'default',
      });
    });

    test('finds chromium in PATH on win32 when defaults absent', async () => {
      const sys = makeSys({
        platform: 'win32',
        env: {
          PATH: 'C:\\bin;C:\\Windows',
        },
        executables: ['C:\\bin\\chromium.exe'],
      });
      const res = await discoverChrome(undefined, sys);
      expect(res).toEqual({
        kind: 'found',
        path: 'C:\\bin\\chromium.exe',
        source: 'path',
      });
    });
  });
});

describe('launchChrome with fake stream binary', () => {
  const isPosix = process.platform !== 'win32';

  test('successfully launches, handshakes, and closes with clean profile removal', async () => {
    if (!isPosix) return;

    const fakeBinPath = path.join(tmpdir(), `fake-chrome-${Date.now()}.mjs`);
    const script = `#!/usr/bin/env node
import fs from 'node:fs';

const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });

input.on('data', (chunk) => {
  const str = chunk.toString('utf8');
  if (str.includes('Browser.getVersion')) {
    output.write(JSON.stringify({ id: 1, result: { product: 'MockChrome/120.0' } }) + '\\0');
  }
  if (str.includes('Browser.close')) {
    process.exit(0);
  }
});
`;
    await writeFile(fakeBinPath, script, { mode: 0o755 });

    const running = await launchChrome(fakeBinPath, {
      startupTimeoutMs: 3000,
    });

    expect(running.product).toBe('MockChrome/120.0');
    await running.close();

    await rm(fakeBinPath, { force: true });
  });

  test('kills a browser that never answers Browser.close and waits for exit', async () => {
    if (!isPosix) return;
    const fakeBinPath = path.join(
      tmpdir(),
      `fake-wedged-chrome-${Date.now()}.mjs`
    );
    const script = `#!/usr/bin/env node
import fs from 'node:fs';
const input = fs.createReadStream(null, { fd: 3 });
const output = fs.createWriteStream(null, { fd: 4 });
input.on('data', chunk => {
  if (chunk.toString('utf8').includes('Browser.getVersion'))
    output.write(JSON.stringify({id:1,result:{product:'MockChrome/120.0'}})+'\\0');
});
`;
    await writeFile(fakeBinPath, script, { mode: 0o755 });
    try {
      const running = await launchChrome(fakeBinPath, {
        startupTimeoutMs: 3000,
      });
      expect(running.pid).toBeDefined();
      await running.close();
      expect(() => process.kill(running.pid!, 0)).toThrow();
    } finally {
      await rm(fakeBinPath, { force: true });
    }
  }, 15000);

  test('throws ChromeLaunchError on early exit and captures stderr tail', async () => {
    if (!isPosix) return;

    const fakeBinPath = path.join(
      tmpdir(),
      `fake-crash-chrome-${Date.now()}.mjs`
    );
    const script = `#!/usr/bin/env node
process.stderr.write('Chrome failed to start: sandbox initialization error\\n');
process.exit(1);
`;
    await writeFile(fakeBinPath, script, { mode: 0o755 });

    let caught: unknown;
    try {
      await launchChrome(fakeBinPath, { startupTimeoutMs: 2000 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ChromeLaunchError);
    const launchErr = caught as ChromeLaunchError;
    expect(launchErr.stderrTail).toContain('sandbox initialization error');

    await rm(fakeBinPath, { force: true });
  });

  test('throws ChromeLaunchError on startup timeout', async () => {
    if (!isPosix) return;

    const fakeBinPath = path.join(
      tmpdir(),
      `fake-slow-chrome-${Date.now()}.sh`
    );
    // A browser that starts and then never answers. It must stay alive for
    // the whole startup window, held open by the CDP pipes the way Chrome is.
    // Holding both fd 3 and fd 4 open keeps the pipes alive without writing
    // any response on fd 4 until the launcher startup timeout kills it.
    const script = `#!/bin/sh
exec sleep 1000 <&3 >&4
`;
    await writeFile(fakeBinPath, script, { mode: 0o755 });

    let caught: unknown;
    try {
      await launchChrome(fakeBinPath, { startupTimeoutMs: 100 });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ChromeLaunchError);
    const launchErr = caught as ChromeLaunchError;
    expect(launchErr.message).toContain('failed to answer Browser.getVersion');

    await rm(fakeBinPath, { force: true });
  });
});
