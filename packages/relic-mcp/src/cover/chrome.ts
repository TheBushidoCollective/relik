import { type ChildProcess, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type CdpConnection, connectPipe } from './cdp.ts';

export type ChromeDiscovery =
  | { kind: 'found'; path: string; source: 'env' | 'default' | 'path' }
  | { kind: 'disabled'; detail: string }
  | { kind: 'not_found'; detail: string; searched: readonly string[] };

export interface DiscoverySystem {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly homedir: string;
  readonly isExecutable: (path: string) => Promise<boolean>;
}

export class ChromeLaunchError extends Error {
  readonly stderrTail: string;

  constructor(message: string, stderrTail: string) {
    super(message);
    this.name = 'ChromeLaunchError';
    this.stderrTail = stderrTail;
  }
}

export interface RunningChrome {
  readonly cdp: CdpConnection;
  readonly product: string;
  close(): Promise<void>;
  kill?: () => void;
  /** The browser process id, when it could be read. */
  readonly pid?: number | undefined;
}

export function defaultDiscoverySystem(): DiscoverySystem {
  return {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    isExecutable: async (filePath: string) => {
      try {
        await fs.access(filePath, constants.X_OK);
        const stat = await fs.stat(filePath);
        return stat.isFile();
      } catch {
        return false;
      }
    },
  };
}

async function findInPath(
  binaryName: string,
  sys: DiscoverySystem
): Promise<string | undefined> {
  const p = sys.platform === 'win32' ? path.win32 : path.posix;
  const pathVal = sys.env['PATH'] ?? sys.env['Path'] ?? '';
  const delimiter = sys.platform === 'win32' ? ';' : ':';
  const dirs = pathVal.split(delimiter).filter(Boolean);

  for (const dir of dirs) {
    const candidate = p.join(dir, binaryName);
    if (await sys.isExecutable(candidate)) {
      return candidate;
    }
    if (
      sys.platform === 'win32' &&
      !binaryName.toLowerCase().endsWith('.exe')
    ) {
      const candidateExe = p.join(dir, `${binaryName}.exe`);
      if (await sys.isExecutable(candidateExe)) {
        return candidateExe;
      }
    }
  }

  return undefined;
}

export async function discoverChrome(
  override: string | undefined,
  sys: DiscoverySystem = defaultDiscoverySystem()
): Promise<ChromeDiscovery> {
  if (override !== undefined) {
    if (override === 'none' || override === 'disabled') {
      return {
        kind: 'disabled',
        detail: `Cover rendering is disabled (chromePath is ${override})`,
      };
    }
    const executable = await sys.isExecutable(override);
    if (executable) {
      return {
        kind: 'found',
        path: override,
        source: 'env',
      };
    }
    return {
      kind: 'not_found',
      detail: `RELIC_CHROME_PATH points at ${override}, which is not an executable file`,
      searched: [override],
    };
  }

  const envChromePath = sys.env['RELIC_CHROME_PATH'];
  if (envChromePath !== undefined) {
    if (envChromePath === 'none' || envChromePath === 'disabled') {
      return {
        kind: 'disabled',
        detail: `Cover rendering is disabled (RELIC_CHROME_PATH is ${envChromePath})`,
      };
    }
    const executable = await sys.isExecutable(envChromePath);
    if (executable) {
      return {
        kind: 'found',
        path: envChromePath,
        source: 'env',
      };
    }
    return {
      kind: 'not_found',
      detail: `RELIC_CHROME_PATH points at ${envChromePath}, which is not an executable file`,
      searched: [envChromePath],
    };
  }

  const p = sys.platform === 'win32' ? path.win32 : path.posix;
  const searched: string[] = [];

  if (sys.platform === 'darwin') {
    const darwinDefaults = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      p.join(
        sys.homedir,
        'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      ),
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    ];

    for (const candidate of darwinDefaults) {
      searched.push(candidate);
      if (await sys.isExecutable(candidate)) {
        return {
          kind: 'found',
          path: candidate,
          source: 'default',
        };
      }
    }

    const pathCandidates = ['chrome-headless-shell', 'chromium'];
    for (const binName of pathCandidates) {
      searched.push(binName);
      const found = await findInPath(binName, sys);
      if (found) {
        return {
          kind: 'found',
          path: found,
          source: 'path',
        };
      }
    }
  } else if (sys.platform === 'linux') {
    const linuxPathCandidates = [
      'google-chrome-stable',
      'google-chrome',
      'chromium',
      'chromium-browser',
      'microsoft-edge-stable',
      'microsoft-edge',
      'chrome-headless-shell',
    ];

    for (const binName of linuxPathCandidates) {
      searched.push(binName);
      const found = await findInPath(binName, sys);
      if (found) {
        return {
          kind: 'found',
          path: found,
          source: 'path',
        };
      }
    }

    const linuxDefaults = ['/opt/google/chrome/chrome', '/snap/bin/chromium'];
    for (const candidate of linuxDefaults) {
      searched.push(candidate);
      if (await sys.isExecutable(candidate)) {
        return {
          kind: 'found',
          path: candidate,
          source: 'default',
        };
      }
    }
  } else if (sys.platform === 'win32') {
    const progFiles = sys.env['PROGRAMFILES'] ?? sys.env['ProgramFiles'];
    const progFilesX86 =
      sys.env['PROGRAMFILES(X86)'] ?? sys.env['ProgramFiles(x86)'];
    const localAppData = sys.env['LOCALAPPDATA'] ?? sys.env['LocalAppData'];

    const winDefaults: string[] = [];
    if (progFiles) {
      winDefaults.push(
        p.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')
      );
    }
    if (progFilesX86) {
      winDefaults.push(
        p.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
      );
    }
    if (localAppData) {
      winDefaults.push(
        p.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe')
      );
    }
    if (progFilesX86) {
      winDefaults.push(
        p.join(progFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }
    if (progFiles) {
      winDefaults.push(
        p.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
      );
    }

    for (const candidate of winDefaults) {
      searched.push(candidate);
      if (await sys.isExecutable(candidate)) {
        return {
          kind: 'found',
          path: candidate,
          source: 'default',
        };
      }
    }

    const pathCandidates = ['chrome-headless-shell', 'chromium'];
    for (const binName of pathCandidates) {
      searched.push(binName);
      const found = await findInPath(binName, sys);
      if (found) {
        return {
          kind: 'found',
          path: found,
          source: 'path',
        };
      }
    }
  } else {
    const fallbackPathCandidates = [
      'chrome-headless-shell',
      'chromium',
      'google-chrome',
    ];
    for (const binName of fallbackPathCandidates) {
      searched.push(binName);
      const found = await findInPath(binName, sys);
      if (found) {
        return {
          kind: 'found',
          path: found,
          source: 'path',
        };
      }
    }
  }

  return {
    kind: 'not_found',
    detail: `No Chrome, Chromium, or Edge was found on this machine (looked in: ${searched.join(', ')}). Set RELIC_CHROME_PATH to one to render covers.`,
    searched,
  };
}

export function chromeArgs(
  binaryPath: string,
  userDataDir: string
): readonly string[] {
  const isHeadlessShell = path.basename(binaryPath).includes('headless-shell');
  const headlessFlag = isHeadlessShell ? '--headless' : '--headless=new';

  return [
    headlessFlag,
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
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
}

export async function launchChrome(
  binaryPath: string,
  options: {
    readonly startupTimeoutMs: number;
    /** Directory the temporary profile is created in. Defaults to the OS temp dir. */
    readonly profileParent?: string;
    /** Wrap the browser in this launcher: its command, then the arguments before the binary. */
    readonly launcher?: {
      readonly command: string;
      readonly prefixArgs: readonly string[];
    };
    /** Extra arguments placed before the trailing about:blank. */
    readonly extraArgs?: readonly string[];
    /** The environment for the browser process. Defaults to inheriting this process's. */
    readonly env?: NodeJS.ProcessEnv;
  }
): Promise<RunningChrome> {
  const profileDir = await fs.mkdtemp(
    path.join(options.profileParent ?? os.tmpdir(), 'relic-chrome-')
  );
  await fs.chmod(profileDir, 0o700);

  const base = chromeArgs(binaryPath, profileDir);
  const args = [
    ...base.slice(0, -1),
    ...(options.extraArgs ?? []),
    base[base.length - 1]!,
  ];
  const launch =
    options.launcher === undefined
      ? { command: binaryPath, commandArgs: args }
      : {
          command: options.launcher.command,
          commandArgs: [...options.launcher.prefixArgs, binaryPath, ...args],
        };

  const MAX_STDERR = 2048;
  const stderrChunks: Buffer[] = [];
  let stderrLength = 0;

  function appendStderr(chunk: Buffer | Uint8Array | string): void {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    stderrChunks.push(buf);
    stderrLength += buf.length;
    while (stderrChunks.length > 0) {
      const first = stderrChunks[0];
      if (!first || stderrLength - first.length < MAX_STDERR) {
        break;
      }
      stderrLength -= first.length;
      stderrChunks.shift();
    }
  }

  function getStderrTail(): string {
    if (stderrChunks.length === 0) return '';
    const combined = Buffer.concat(stderrChunks);
    if (combined.length <= MAX_STDERR) {
      return combined.toString('utf8');
    }
    return combined.subarray(combined.length - MAX_STDERR).toString('utf8');
  }

  let child: ChildProcess;
  try {
    child = spawn(launch.command, [...launch.commandArgs], {
      stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
      env: options.env,
    });
  } catch (err: unknown) {
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    const msg = err instanceof Error ? err.message : String(err);
    throw new ChromeLaunchError(
      `Failed to spawn Chrome at ${binaryPath}: ${msg}`,
      ''
    );
  }

  const stderrStream = child.stdio[2] as NodeJS.ReadableStream | null;
  if (stderrStream) {
    stderrStream.on('data', appendStderr);
    stderrStream.on('error', () => {});
  }

  const toChrome = child.stdio[3] as NodeJS.WritableStream | null;
  const fromChrome = child.stdio[4] as NodeJS.ReadableStream | null;

  if (!toChrome || !fromChrome) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Best effort
    }
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw new ChromeLaunchError(
      'Failed to establish stdio pipes 3 and 4 with Chrome',
      getStderrTail()
    );
  }

  let childSpawnError: Error | undefined;
  child.on('error', (err) => {
    childSpawnError = err;
  });

  const cdp = connectPipe(toChrome, fromChrome);

  let timer: NodeJS.Timeout | number | undefined;
  let exitListener:
    | ((code: number | null, signal: NodeJS.Signals | null) => void)
    | undefined;

  let product = '';
  try {
    const startupPromise = new Promise<{ product: string }>(
      (resolve, reject) => {
        exitListener = (code, signal) => {
          reject(
            new ChromeLaunchError(
              `Chrome exited during startup (code: ${code}, signal: ${signal})`,
              getStderrTail()
            )
          );
        };
        child.once('exit', exitListener);

        if (childSpawnError) {
          reject(
            new ChromeLaunchError(
              `Failed to start Chrome: ${childSpawnError.message}`,
              getStderrTail()
            )
          );
          return;
        }

        timer = setTimeout(() => {
          reject(
            new ChromeLaunchError(
              `Chrome failed to answer Browser.getVersion within ${options.startupTimeoutMs}ms`,
              getStderrTail()
            )
          );
        }, options.startupTimeoutMs);

        cdp
          .send('Browser.getVersion')
          .then((res) => {
            resolve({
              product: typeof res['product'] === 'string' ? res['product'] : '',
            });
          })
          .catch((err) => {
            if (childSpawnError) {
              reject(
                new ChromeLaunchError(
                  `Failed to start Chrome: ${childSpawnError.message}`,
                  getStderrTail()
                )
              );
              return;
            }
            if (child.exitCode !== null || child.signalCode !== null) {
              reject(
                new ChromeLaunchError(
                  `Chrome exited during startup (code: ${child.exitCode}, signal: ${child.signalCode})`,
                  getStderrTail()
                )
              );
              return;
            }

            // When the CDP pipe closes during startup, the child may be in the
            // process of exiting. Wait briefly for the exit or error event so
            // we report the actual exit code, signal, and captured stderr.
            setTimeout(() => {
              reject(
                new ChromeLaunchError(
                  `Browser.getVersion failed: ${err instanceof Error ? err.message : String(err)}`,
                  getStderrTail()
                )
              );
            }, 100);
          });
      }
    );

    const result = await startupPromise;
    product = result.product;
  } catch (err) {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (exitListener) {
      child.removeListener('exit', exitListener);
      exitListener = undefined;
    }
    cdp.dispose();
    try {
      child.kill('SIGKILL');
    } catch {
      // Best effort
    }
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('close', () => resolve());
        setTimeout(resolve, 500);
      });
    }
    await fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
    if (err instanceof ChromeLaunchError) {
      throw err;
    }
    throw new ChromeLaunchError(
      `Chrome startup failed: ${err instanceof Error ? err.message : String(err)}`,
      getStderrTail()
    );
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (exitListener) {
      child.removeListener('exit', exitListener);
      exitListener = undefined;
    }
  }

  let closePromise: Promise<void> | undefined;

  function close(): Promise<void> {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve, reject) => {
          let killTimer: NodeJS.Timeout | number | undefined;
          let exitTimer: NodeJS.Timeout | number | undefined;
          const onExit = () => {
            clearTimeout(killTimer);
            clearTimeout(exitTimer);
            resolve();
          };
          child.once('exit', onExit);
          killTimer = setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // Wait for exit or report that cleanup could not be established.
            }
            exitTimer = setTimeout(() => {
              child.removeListener('exit', onExit);
              reject(new Error('Browser did not exit after SIGKILL'));
            }, 5000);
          }, 5000);
          // Arm the watchdog before asking the browser to close.
          void cdp.send('Browser.close').catch(() => {});
        });
      }

      cdp.dispose();

      try {
        await fs.rm(profileDir, { recursive: true, force: true });
      } catch {
        // Best effort
      }
    })();

    return closePromise;
  }

  function kill(): void {
    try {
      child.kill('SIGKILL');
    } catch {
      // Best effort
    }
    cdp.dispose();
    fs.rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }

  return {
    cdp,
    product,
    close,
    kill,
    pid: child.pid,
  };
}
