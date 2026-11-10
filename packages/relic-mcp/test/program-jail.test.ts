import { describe, expect, test } from 'bun:test';
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confinedEnv,
  launcherFor,
  macosJailProfile,
  plainPath,
} from '../src/program/confine.ts';
import { resolveProgramBrowser } from '../src/program/browser.ts';
import { programProfileSourceFrom } from '../src/program/policy.ts';

describe('program confinement', () => {
  test('denies by default and narrows writes to mounted subdirectory', () => {
    const profile = macosJailProfile({
      shell: '/opt/shell/chrome-headless-shell',
      ramRoot: '/private/tmp/ram',
    });
    expect(
      profile.startsWith('(version 1)\n(deny default (with no-log))')
    ).toBe(true);
    for (const forbidden of [
      '(allow default',
      '(allow network',
      '(allow system-socket',
      '(with no-sandbox)',
      '(allow user-preference',
      '(allow ipc-posix',
      '(allow file-issue-extension',
    ])
      expect(profile).not.toContain(forbidden);
    expect(profile).toContain(
      '(allow file-write* (subpath "/private/tmp/ram/w")'
    );
    expect(launcherFor(profile, 'linux')).toBeUndefined();
    expect(programProfileSourceFrom({}, 'linux').kind).toBe('unsupported');
  });
  test('rejects paths that can change the profile', () => {
    for (const p of ['/tmp/a b', '/tmp/a"b', '/tmp/(a)', '/tmp/../a'])
      expect(() => plainPath(p)).toThrow();
  });
  test('does not inherit secrets', () => {
    process.env['RELIC_JAIL_CANARY'] = 'secret';
    const env = confinedEnv({
      root: '/tmp/r',
      home: '/tmp/r/home',
      tmp: '/tmp/r/tmp',
      cache: '/tmp/r/cache',
      config: '/tmp/r/config',
      data: '/tmp/r/data',
      crash: '/tmp/r/crash',
    });
    expect(env['RELIC_JAIL_CANARY']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin:/bin');
    delete process.env['RELIC_JAIL_CANARY'];
  });
  test('rejects extra entries and symlinks beside shell', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jail-layout-'));
    try {
      const shell = join(root, 'chrome-headless-shell');
      await writeFile(shell, '');
      await chmod(shell, 0o700);
      expect((await resolveProgramBrowser(shell)).ok).toBe(true);
      await writeFile(join(root, 'extra'), '');
      expect((await resolveProgramBrowser(shell)).ok).toBe(false);
      await rm(join(root, 'extra'));
      await mkdir(join(root, 'resources'));
      await symlink(shell, join(root, 'icudtl.dat'));
      expect((await resolveProgramBrowser(shell)).ok).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
