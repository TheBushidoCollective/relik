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
import {
  programAssetDir,
  programProfileSourceFrom,
} from '../src/program/policy.ts';
import { sanitizePageReasons } from '../src/program/render.ts';

describe('program confinement', () => {
  test('finds source-tree program assets and honors the explicit override', () => {
    expect(programAssetDir({})).toBe(
      new URL('../dist/program/', import.meta.url).pathname
    );
    expect(programAssetDir({ RELIC_MCP_PROGRAM_DIR: '/custom/program' })).toBe(
      '/custom/program'
    );
  });
  test('never returns browser-controlled reason text or fields', () => {
    const secret = 'confidential source effect name';
    const reasons = sanitizePageReasons([
      {
        code: 'unsupported-effect',
        message: secret,
        node_id: secret,
        time: { value: 1, rate: 1 },
      },
      { code: 'unsupported-effect', message: secret },
      { code: secret, message: secret },
      { code: '__proto__', message: secret },
    ]);
    expect(reasons).toEqual([
      {
        code: 'unsupported-effect',
        message: 'the timeline contains an unsupported effect',
      },
    ]);
    expect(JSON.stringify(reasons)).not.toContain(secret);
    expect(
      sanitizePageReasons([{ code: 'not-a-code', message: secret }])
    ).toEqual([]);
  });
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
      for (const name of [
        'headless_command_resources.pak',
        'headless_lib_strings.pak',
        'headless_lib_data.pak',
      ]) {
        await writeFile(join(root, name), '');
      }
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
