/**
 * A private, memory-backed RAM volume for the browser's profile on macOS.
 *
 * The profile lives only on a RAM disk this process created, formatted,
 * mounted at a directory it made, and verified. Nothing is left behind: the
 * volume is unmounted and detached on release, and the mount directory is
 * removed. No claim is made about physical swap.
 *
 * Ownership: every operation names the exact device node this process
 * attached, the exact mount point it created, and the exact image it verified
 * (image-path ram://<sectors>, owned by this user). When an identity check
 * cannot be made, the operation refuses and changes nothing. A cleanup failure
 * is always an error, never swallowed.
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Storage could not be created, verified, or released. `cleanupFailed` marks a
 * failure to release storage this process made, which must refuse the publish
 * rather than degrade to focus-only.
 */
export class ProgramStorageError extends Error {
  override readonly name = 'ProgramStorageError';
  constructor(
    message: string,
    readonly cleanupFailed = false
  ) {
    super(message);
  }
}

export interface PrivateRamVolume {
  /** The device node this process attached, e.g. /dev/disk8. */
  readonly device: string;
  readonly volumeName: string;
  readonly sectors: number;
  /** The directory this process created and mounted the volume on. */
  readonly mountPoint: string;
}

interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const TOOL_TIMEOUT_MS = 120_000;
const DETACH_RETRY_DELAY_MS = 1_000;

/** Runs a fixed tool with explicit arguments. No shell, no string interpolation. */
export function run(
  command: string,
  args: readonly string[],
  input = ''
): Promise<ToolResult> {
  const { promise, resolve, reject } = Promise.withResolvers<ToolResult>();
  const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGKILL'), TOOL_TIMEOUT_MS);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code: code ?? -1, stdout, stderr });
  });
  child.stdin.end(input);
  return promise;
}

type Json = Record<string, unknown>;

async function plistToJson(plist: string): Promise<unknown> {
  const converted = await run(
    'plutil',
    ['-convert', 'json', '-o', '-', '-'],
    plist
  );
  if (converted.code !== 0) {
    throw new ProgramStorageError(
      `could not read a system record: ${converted.stderr.trim()}`
    );
  }
  return JSON.parse(converted.stdout) as unknown;
}

/** The hdiutil record for a device node, or undefined when it is not attached. */
async function imageFor(device: string): Promise<Json | undefined> {
  const info = await run('hdiutil', ['info', '-plist']);
  if (info.code !== 0) {
    throw new ProgramStorageError(`hdiutil info failed: ${info.stderr.trim()}`);
  }
  const parsed = (await plistToJson(info.stdout)) as { images?: Json[] };
  return (parsed.images ?? []).find((image) => {
    const entities = (image['system-entities'] ?? []) as Json[];
    return entities.some((entity) => entity['dev-entry'] === device);
  });
}

async function diskInfo(device: string): Promise<Json> {
  const info = await run('diskutil', ['info', '-plist', device]);
  if (info.code !== 0) {
    throw new ProgramStorageError(
      `diskutil info ${device} failed: ${info.stderr.trim()}`
    );
  }
  return (await plistToJson(info.stdout)) as Json;
}

/**
 * Proves the device is still the RAM image this process attached: a ram:// image
 * of the expected size, owned by this user. Throws otherwise.
 */
async function assertOurImage(device: string, sectors: number): Promise<void> {
  const image = await imageFor(device);
  if (image === undefined) {
    throw new ProgramStorageError(
      `${device} is no longer attached, so it cannot be verified as ours`
    );
  }
  if (image['image-path'] !== `ram://${sectors}`) {
    throw new ProgramStorageError(
      `${device} is backed by ${String(image['image-path'])}, not a RAM disk of ${sectors} sectors`
    );
  }
  if (image['owner-uid'] !== process.getuid?.()) {
    throw new ProgramStorageError(`${device} is not owned by this user`);
  }
}

/** Detaches one device node. Retries once, because a just-unmounted volume can still be busy. */
async function detach(device: string): Promise<void> {
  let result = await run('hdiutil', ['detach', device]);
  if (result.code !== 0) {
    await new Promise((resolve) => setTimeout(resolve, DETACH_RETRY_DELAY_MS));
    result = await run('hdiutil', ['detach', device]);
  }
  if (result.code !== 0) {
    throw new ProgramStorageError(
      `could not detach ${device}: ${result.stderr.trim()}`,
      true
    );
  }
  if ((await imageFor(device)) !== undefined) {
    throw new ProgramStorageError(
      `${device} is still attached after detach`,
      true
    );
  }
}

/**
 * Releases what this process made: unmounts the mount point it created and
 * detaches the device it attached. Used both after a failed create and by the
 * normal release. Every failure is a cleanupFailed error.
 */
async function releaseOwned(
  device: string,
  sectors: number,
  mountPoint: string | undefined
): Promise<void> {
  if ((await imageFor(device)) === undefined) {
    if (mountPoint !== undefined) await rmdir(mountPoint);
    return;
  }
  await assertOurImage(device, sectors);
  // diskutil reports the canonical path (/private/var/...), so compare that.
  const expected =
    mountPoint === undefined
      ? undefined
      : await realpath(mountPoint).catch(() => mountPoint);
  const info = await diskInfo(device);
  const mountedAt = info['MountPoint'];
  if (typeof mountedAt === 'string' && mountedAt !== '') {
    if (expected === undefined || mountedAt !== expected) {
      throw new ProgramStorageError(
        `${device} is mounted at ${mountedAt}, not at the directory this process made, so it is not released`,
        true
      );
    }
    const unmount = await run('diskutil', ['unmount', expected]);
    if (unmount.code !== 0) {
      throw new ProgramStorageError(
        `could not unmount ${mountPoint}: ${unmount.stderr.trim()}`,
        true
      );
    }
  }
  await detach(device);
  if (mountPoint !== undefined) await rmdir(mountPoint);
}

/**
 * Attaches, formats, and privately mounts a RAM volume of `sizeMiB`. Each step
 * is verified. A failure releases what was made before the error is thrown; a
 * failure to release is thrown with `cleanupFailed` set.
 */
export async function createPrivateRamVolume(
  sizeMiB: number
): Promise<PrivateRamVolume> {
  if (process.platform !== 'darwin') {
    throw new ProgramStorageError(
      'private RAM volumes are only created on macOS here'
    );
  }
  const sectors = sizeMiB * 2048;
  const attach = await run('hdiutil', [
    'attach',
    '-nomount',
    `ram://${sectors}`,
  ]);
  const device = /^\/dev\/disk\d+$/m.exec(attach.stdout)?.[0];
  if (attach.code !== 0 || device === undefined) {
    throw new ProgramStorageError(
      `could not attach a RAM disk: ${(attach.stderr || attach.stdout).trim()}`
    );
  }

  // A name nobody else is using, so it can be told apart if the process dies.
  const volumeName = `relicprof${randomBytes(6).toString('hex')}`;
  let mountPoint: string | undefined;
  try {
    await assertOurImage(device, sectors);

    const format = await run('newfs_hfs', ['-v', volumeName, device]);
    if (format.code !== 0) {
      throw new ProgramStorageError(
        `could not format the RAM disk: ${format.stderr.trim()}`
      );
    }

    mountPoint = await mkdtemp(join(tmpdir(), 'relic-prof-'));
    const mounted = await run('diskutil', [
      'mount',
      '-mountPoint',
      mountPoint,
      device,
    ]);
    if (mounted.code !== 0) {
      throw new ProgramStorageError(
        `could not mount the RAM disk: ${mounted.stderr.trim()}`
      );
    }

    const info = await diskInfo(device);
    const canonicalMount = await realpath(mountPoint);
    if (
      info['MountPoint'] !== canonicalMount ||
      info['VolumeName'] !== volumeName ||
      info['FilesystemType'] !== 'hfs' ||
      info['Writable'] !== true
    ) {
      throw new ProgramStorageError(
        `the mounted volume does not match what this process made (${String(info['MountPoint'])})`
      );
    }
    await assertOurImage(device, sectors);
    return { device, volumeName, sectors, mountPoint: canonicalMount };
  } catch (error) {
    try {
      await releaseOwned(device, sectors, mountPoint);
    } catch (cleanupError) {
      throw new ProgramStorageError(
        `${(error as Error).message}; the cleanup also failed: ${(cleanupError as Error).message}`,
        true
      );
    }
    throw error;
  }
}

/**
 * Unmounts only the directory this process mounted, then detaches only the
 * device it attached. Throws a cleanupFailed error on any failure, so a caller
 * cannot treat an unreleased volume as cleaned up.
 */
export async function releasePrivateRamVolume(
  volume: PrivateRamVolume
): Promise<void> {
  await releaseOwned(volume.device, volume.sectors, volume.mountPoint);
}
