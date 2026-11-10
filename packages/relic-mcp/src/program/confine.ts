/**
 * Write confinement for the browser, per platform. Each platform has one
 * launcher that wraps the browser so the OS refuses writes outside the private
 * storage this publish owns, and a probe that must pass before any browser
 * starts.
 *
 * - macOS: /usr/bin/sandbox-exec with a profile that denies every file write
 *   except inside the private RAM volume (and /dev).
 * - Linux: bubblewrap (bwrap), with the root filesystem read-only and a
 *   read-write bind of the per-publish directory inside a verified tmpfs. /tmp
 *   and /dev/shm are memory filesystems, and the network is unshared.
 *
 * Where the launcher tool, the probe, or the storage is missing, no browser
 * starts. That is a fail-closed outcome, not a fallback.
 *
 * Belt and braces: the browser's temp, home, cache, config, and data paths are
 * set inside the private storage, and its disk-cache and crash-dump flags point
 * there too. The process arguments are read back and must carry those flags.
 * The environment cannot be read back on macOS, so it is set by construction.
 *
 * Reads are not confined. Only writes are.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ProgramStorageError, run } from './ramdisk.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const BWRAP = 'bwrap';
const PS = '/bin/ps';

/** A command and the arguments that go before the browser binary. */
export interface Launcher {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface ConfinedPaths {
  readonly root: string;
  readonly tmp: string;
  readonly home: string;
  readonly cache: string;
  readonly config: string;
  readonly data: string;
  readonly crash: string;
}

/** Paths go into profiles and argument lists, so each must be plain. */
function plainPath(path: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..')) {
    throw new ProgramStorageError('the private storage path is not plain');
  }
  return path;
}

/** Denies every write, then allows writes only under the given directories and /dev. */
export function sandboxProfile(writable: readonly string[]): string {
  const allows = writable
    .map((path) => `(allow file-write* (subpath "${plainPath(path)}"))`)
    .join('');
  return `(version 1)(allow default)(deny file-write*)${allows}(allow file-write* (subpath "/dev"))`;
}

/** bubblewrap: read-only root, one read-write bind for the publish's directory, memory /tmp, no network. */
export function bwrapPrefixArgs(root: string): string[] {
  const base = plainPath(root);
  return [
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    '--tmpfs',
    '/tmp',
    '--bind',
    base,
    base,
    '--unshare-net',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--unshare-cgroup-try',
    '--cap-drop',
    'ALL',
    '--new-session',
    '--die-with-parent',
  ];
}

/** The launcher for this platform, or undefined where no confinement exists. */
export function launcherFor(
  root: string,
  platform: NodeJS.Platform = process.platform
): Launcher | undefined {
  if (platform === 'darwin') {
    return {
      command: SANDBOX_EXEC,
      prefixArgs: ['-p', sandboxProfile([root])],
    };
  }
  if (platform === 'linux') {
    return { command: BWRAP, prefixArgs: bwrapPrefixArgs(root) };
  }
  return undefined;
}

/** Makes the browser's temp, home, cache, config, data, and crash directories inside the storage. */
export async function createConfinedPaths(
  root: string
): Promise<ConfinedPaths> {
  const base = plainPath(root);
  const paths = {
    root: base,
    tmp: join(base, 'confine', 'tmp'),
    home: join(base, 'confine', 'home'),
    cache: join(base, 'confine', 'cache'),
    config: join(base, 'confine', 'config'),
    data: join(base, 'confine', 'data'),
    crash: join(base, 'confine', 'crash'),
  };
  for (const dir of Object.values(paths)) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  return paths;
}

export function confinedEnv(paths: ConfinedPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    HOME: paths.home,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
  };
}

export function confinementFlags(paths: ConfinedPaths): string[] {
  return [
    `--disk-cache-dir=${paths.cache}`,
    `--crash-dumps-dir=${paths.crash}`,
  ];
}

export type LauncherCheck = { readonly ok: true } | { readonly ok: false };

/**
 * Runs the write probe through the launcher before any browser starts. Inside
 * the storage a write must succeed; outside it must fail. A missing launcher
 * tool, or any other result, fails closed with no detail recorded.
 */
export async function verifyLauncher(
  launcher: Launcher,
  root: string
): Promise<LauncherCheck> {
  const token = randomBytes(8).toString('hex');
  const inside = join(root, `.launcher-probe-${token}`);
  // Outside every writable path on both platforms: the filesystem root.
  const outside = `/relic-launcher-probe-${token}`;
  try {
    const writeInside = await run(launcher.command, [
      ...launcher.prefixArgs,
      '/bin/sh',
      '-c',
      'echo ok > "$1"',
      'sh',
      inside,
    ]);
    await unlink(inside).catch(() => {});
    if (writeInside.code !== 0) return { ok: false };

    // Writes that must never reach the host: the filesystem root, and on Linux
    // the routes /proc would offer a sandboxed process back to the host root.
    const escapes =
      launcher.command === BWRAP
        ? [`/proc/1/root${outside}`, `/proc/self/root${outside}`]
        : [];
    let reached = false;
    for (const target of [outside, ...escapes]) {
      const write = await run(launcher.command, [
        ...launcher.prefixArgs,
        '/bin/sh',
        '-c',
        'echo x > "$1"',
        'sh',
        target,
      ]);
      if (write.code === 0) reached = true;
    }
    // A write that got through has put a file on the host at the one shared path. Remove it.
    await unlink(outside).catch(() => {});
    return reached ? { ok: false } : { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads the browser process's arguments back from the OS and checks that the
 * confinement flags are present.
 */
export async function verifyArguments(
  pid: number | undefined,
  paths: ConfinedPaths
): Promise<LauncherCheck> {
  if (pid === undefined) return { ok: false };
  try {
    const listed = await run(PS, ['-wwo', 'command=', '-p', String(pid)]);
    if (listed.code !== 0) return { ok: false };
    for (const flag of confinementFlags(paths)) {
      if (!listed.stdout.includes(flag)) return { ok: false };
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}
