/**
 * Linux private storage for the browser: a per-publish directory inside a
 * verified tmpfs mount, owned and removed by this process.
 *
 * The directory must be absolute, must not be under /dev (bubblewrap remounts
 * /dev, which would hide it), and its filesystem must report TMPFS_MAGIC. The
 * per-publish directory is created with mkdtemp, so its name is unique, and
 * release removes exactly that directory.
 */

import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { ProgramStorageError } from './ramdisk.ts';

/** statfs f_type of a tmpfs mount on Linux (TMPFS_MAGIC). */
const TMPFS_MAGIC = 0x01021994;

export interface LinuxStorage {
  readonly parent: string;
  /** Removes exactly the directory this process created. Throws cleanupFailed on failure. */
  readonly release: () => Promise<void>;
}

/** True only when `dir` is an absolute, non-/dev path on a verified tmpfs. */
export async function isVerifiedTmpfs(dir: string): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  if (
    !dir.startsWith('/') ||
    dir.includes('..') ||
    dir === '/dev' ||
    dir.startsWith('/dev/')
  ) {
    return false;
  }
  if (typeof fsp.statfs !== 'function') return false;
  try {
    return Number((await fsp.statfs(dir)).type) === TMPFS_MAGIC;
  } catch {
    return false;
  }
}

/**
 * Creates the per-publish directory inside a verified tmpfs. Returns undefined
 * when the directory cannot be verified, and throws a cleanupFailed error if
 * creating it leaves something behind that cannot be removed.
 */
export async function acquireLinuxStorage(
  dir: string
): Promise<LinuxStorage | undefined> {
  if (!(await isVerifiedTmpfs(dir))) return undefined;
  let parent: string;
  try {
    parent = await fsp.mkdtemp(join(dir, 'relic-prog-'));
  } catch {
    return undefined;
  }
  return {
    parent,
    release: async () => {
      try {
        await fsp.rm(parent, { recursive: true, force: false });
      } catch {
        throw new ProgramStorageError(
          'the program storage directory could not be removed',
          true
        );
      }
    },
  };
}
