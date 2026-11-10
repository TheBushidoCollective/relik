/**
 * The browser that program rendering may use: an isolated headless shell only.
 *
 * Full Chrome is never chosen here. It runs a single-instance check against the
 * user's real profile, which this publisher must not touch. A headless shell has
 * no such check. The choice is an explicit RELIC_OTIO_CHROME_PATH, or else the
 * newest headless shell in the owned-shells location. When neither exists, the
 * result names the reason, and the timelines are focus-only with that reason.
 */

import { access, constants, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export type ProgramBrowser =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'browser-disabled'
        | 'no-headless-shell'
        | 'not-headless-shell';
    };

const OWNED_SHELLS = join(homedir(), '.omp', 'owned-shells');
const SHELL_DIRECTORY = /^chromium_headless_shell-\d+$/;

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const SHELL_ENTRIES = new Set([
  'ABOUT',
  'LICENSE.headless_shell',
  'PrivacySandboxAttestationsPreloaded',
  'resources',
  'chrome-headless-shell',
  'chrome_100_percent.pak',
  'chrome_200_percent.pak',
  'resources.pak',
  'icudtl.dat',
  'libEGL.dylib',
  'libGLESv2.dylib',
  'libvk_swiftshader.dylib',
  'v8_context_snapshot.arm64.bin',
  'v8_context_snapshot.x86_64.bin',
  'vk_swiftshader_icd.json',
  '.DS_Store',
]);

async function checkedShell(path: string): Promise<string | undefined> {
  try {
    const actual = await realpath(path);
    if (
      basename(actual) !== 'chrome-headless-shell' ||
      actual.includes('.app/Contents/') ||
      !(await isExecutable(actual))
    )
      return undefined;
    const entries = await readdir(dirname(actual), { withFileTypes: true });
    if (
      entries.some(
        (e) =>
          !SHELL_ENTRIES.has(e.name) ||
          e.isSymbolicLink() ||
          (e.name === 'resources' ||
          e.name === 'PrivacySandboxAttestationsPreloaded'
            ? !e.isDirectory()
            : !e.isFile())
      )
    )
      return undefined;
    return actual;
  } catch {
    return undefined;
  }
}

export async function resolveProgramBrowser(
  override: string | undefined
): Promise<ProgramBrowser> {
  if (override === 'none' || override === 'disabled') {
    return { ok: false, reason: 'browser-disabled' };
  }
  if (override !== undefined) {
    const path = await checkedShell(override);
    return path
      ? { ok: true, path }
      : { ok: false, reason: 'not-headless-shell' };
  }

  const archDirectory =
    process.arch === 'arm64'
      ? 'chrome-headless-shell-mac-arm64'
      : 'chrome-headless-shell-mac-x64';
  let versions: string[] = [];
  try {
    versions = (await readdir(OWNED_SHELLS))
      .filter((name) => SHELL_DIRECTORY.test(name))
      .sort()
      .reverse();
  } catch {
    versions = [];
  }
  for (const version of versions) {
    const candidate = join(
      OWNED_SHELLS,
      version,
      archDirectory,
      'chrome-headless-shell'
    );
    const path = await checkedShell(candidate);
    if (path) return { ok: true, path };
  }
  return { ok: false, reason: 'no-headless-shell' };
}
