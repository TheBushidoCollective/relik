import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProgramStorageError, run } from './ramdisk.ts';

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const JAIL_FLAGS = [
  '--no-sandbox',
  '--disable-gpu',
  '--disable-accelerated-video-decode',
  '--disable-accelerated-video-encode',
] as const;
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
export function plainPath(path: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(path) || path.includes('..'))
    throw new ProgramStorageError('the confinement path is not plain');
  return path;
}
function ancestors(path: string): string[] {
  const result: string[] = [];
  for (let p = dirname(path); p !== '/'; p = dirname(p)) result.push(p);
  return result;
}
export function macosJailProfile({
  shell,
  ramRoot,
}: {
  shell: string;
  ramRoot: string;
}): string {
  plainPath(shell);
  plainPath(ramRoot);
  const shellDir = plainPath(dirname(shell));
  const dirs = [...new Set([...ancestors(shellDir), ...ancestors(ramRoot)])]
    .map((p) => `(literal "${plainPath(p)}")`)
    .join(' ');
  return `(version 1)
(deny default (with no-log))
(allow file-read* (literal "/"))
(allow file-read* file-map-executable
  (subpath "/System/Volumes/Preboot/Cryptexes/OS") (subpath "/System/Cryptexes/OS")
  (subpath "/usr/lib") (subpath "/System/Library/Frameworks")
  (subpath "/System/Library/PrivateFrameworks") (subpath "/System/Library/Components/AudioCodecs.component"))
(allow file-read*
  (subpath "/Library/Apple/System/Library/Frameworks") (subpath "/Library/Apple/System/Library/PrivateFrameworks")
  (subpath "/System/Library/CoreServices/SystemAppearance.bundle") (subpath "/System/Library/CoreServices/CoreTypes.bundle")
  (subpath "/System/Library/CoreServices/SystemVersion.bundle") (literal "/System/Library/CoreServices/SystemVersion.plist")
  (literal "/System/Library/CoreServices/SystemVersionCompat.plist") (subpath "/System/Library/Fonts") (subpath "/Library/Fonts")
  (subpath "/usr/share/icu") (subpath "/usr/share/locale") (subpath "/private/var/db/timezone") (subpath "/System/Library/ColorSync/Profiles"))
(allow file-read-metadata ${dirs} (literal "/private") (literal "/var") (literal "/tmp") (literal "/etc") (literal "/dev") (literal "/System/Volumes/Data"))
(allow sysctl-read
  (sysctl-name "hw.activecpu") (sysctl-name "hw.busfrequency_compat") (sysctl-name "hw.byteorder") (sysctl-name "hw.cacheconfig")
  (sysctl-name "hw.cachelinesize_compat") (sysctl-name "hw.cpufamily") (sysctl-name "hw.cpufrequency_compat") (sysctl-name "hw.cputype")
  (sysctl-name "hw.l1dcachesize_compat") (sysctl-name "hw.l1icachesize_compat") (sysctl-name "hw.l2cachesize_compat") (sysctl-name "hw.l3cachesize_compat")
  (sysctl-name "hw.logicalcpu_max") (sysctl-name "hw.machine") (sysctl-name "hw.memsize") (sysctl-name "hw.ncpu") (sysctl-name "hw.nperflevels")
  (sysctl-name "hw.packages") (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.physicalcpu_max") (sysctl-name "hw.tbfrequency_compat")
  (sysctl-name "hw.vectorunit") (sysctl-name "kern.hostname") (sysctl-name "kern.hv_vmm_present") (sysctl-name "kern.maxfilesperproc")
  (sysctl-name "kern.osproductversion") (sysctl-name "kern.osrelease") (sysctl-name "kern.ostype") (sysctl-name "kern.osvariant_status")
  (sysctl-name "kern.osversion") (sysctl-name "kern.secure_kernel") (sysctl-name "kern.usrstack64") (sysctl-name "kern.version")
  (sysctl-name "sysctl.proc_cputype") (sysctl-name-prefix "hw.optional.") (sysctl-name-prefix "hw.perflevel"))
(allow process-exec (literal "${shell}"))
(allow file-read* file-map-executable (subpath "${shellDir}") (subpath "/System/Volumes/Data${shellDir}"))
(allow process-fork)
(allow signal (target same-sandbox))
(allow process-info* (target same-sandbox))
(allow mach-register (global-name-regex #"\\.MachPortRendezvousServer\\.[0-9]+$"))
(allow mach-lookup (global-name-regex #"\\.MachPortRendezvousServer\\.[0-9]+$") (global-name "com.apple.audio.AudioComponentRegistrar"))
(allow iokit-open (iokit-registry-entry-class "RootDomainUserClient"))
(allow file-read* (subpath "${ramRoot}") (subpath "/System/Volumes/Data${ramRoot}"))
(allow file-write* (subpath "${ramRoot}/w") (subpath "/System/Volumes/Data${ramRoot}/w"))
(allow file-read-data file-write-data (literal "/dev/null"))
(allow file-read-data (literal "/dev/random") (literal "/dev/urandom"))`;
}
export function launcherFor(
  profile: string,
  platform: NodeJS.Platform = process.platform
): Launcher | undefined {
  return platform === 'darwin'
    ? { command: SANDBOX_EXEC, prefixArgs: ['-p', profile] }
    : undefined;
}
export async function createConfinedPaths(
  root: string
): Promise<ConfinedPaths> {
  const base = plainPath(join(root, 'w'));
  const paths = {
    root: base,
    tmp: join(base, 'confine', 'tmp'),
    home: join(base, 'confine', 'home'),
    cache: join(base, 'confine', 'cache'),
    config: join(base, 'confine', 'config'),
    data: join(base, 'confine', 'data'),
    crash: join(base, 'confine', 'crash'),
  };
  for (const dir of Object.values(paths))
    await mkdir(dir, { recursive: true, mode: 0o700 });
  return paths;
}
export function confinedEnv(paths: ConfinedPaths): NodeJS.ProcessEnv {
  return {
    HOME: paths.home,
    CFFIXED_USER_HOME: paths.home,
    TMPDIR: paths.tmp,
    TMP: paths.tmp,
    TEMP: paths.tmp,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    PATH: '/usr/bin:/bin',
  };
}
export function confinementFlags(paths: ConfinedPaths): string[] {
  return [
    `--disk-cache-dir=${paths.cache}`,
    `--crash-dumps-dir=${paths.crash}`,
  ];
}
export async function verifyArguments(
  pid: number | undefined,
  paths: ConfinedPaths,
  shell: string
): Promise<{ ok: boolean }> {
  if (pid === undefined) return { ok: false };
  try {
    const result = await run('/bin/ps', [
      '-ww',
      '-p',
      String(pid),
      '-o',
      'uid=',
      '-o',
      'ppid=',
      '-o',
      'command=',
    ]);
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/s.exec(result.stdout);
    return {
      ok:
        result.code === 0 &&
        !!match &&
        Number(match[1]) === process.getuid?.() &&
        Number(match[2]) === process.pid &&
        match[3]!.startsWith(`${shell} `) &&
        [...JAIL_FLAGS, ...confinementFlags(paths)].every((flag) =>
          match[3]!.split(/\s+/).includes(flag)
        ),
    };
  } catch {
    return { ok: false };
  }
}
