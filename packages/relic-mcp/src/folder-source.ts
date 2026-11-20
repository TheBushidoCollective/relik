import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  checkEntrySet,
  compareEntryPaths,
  MAX_ENTRIES,
  normaliseEntryPath,
} from '@relic/format';

export type FolderOmissionReason =
  | 'git_metadata'
  | 'node_modules'
  | 'os_metadata'
  | 'symlink'
  | 'not_regular_file'
  | 'unpublishable_name'
  | 'path_too_long'
  | 'path_too_deep'
  | 'gitignore'
  | 'submodule'
  | 'nested_repository'
  | 'missing';
export interface FolderOmission {
  readonly path: string;
  readonly reason: FolderOmissionReason;
}
export interface FolderReport {
  readonly source: 'directory' | 'zip';
  readonly file_count: number;
  readonly files_total_bytes: number;
  readonly file_list_bytes: number;
  readonly default_entry: string;
  readonly sample: readonly string[];
  readonly left_out: {
    readonly count: number;
    readonly by_reason: Readonly<Partial<Record<FolderOmissionReason, number>>>;
    readonly sample: readonly FolderOmission[];
  };
}
export interface FolderFile {
  readonly path: string;
  readonly sourcePath: string;
  readonly size: number;
}
export type FolderWalkResult =
  | {
      readonly ok: true;
      readonly files: readonly FolderFile[];
      readonly leftOut: readonly FolderOmission[];
    }
  | {
      readonly ok: false;
      readonly code:
        | 'folder_empty'
        | 'all-excluded'
        | 'path_collision'
        | 'too_many_files'
        | 'gitignore_unavailable';
      readonly details: Readonly<Record<string, unknown>>;
    };

const exec = promisify(execFile);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const gitOptions = {
  encoding: 'buffer' as const,
  maxBuffer: 64 * 1024 * 1024,
  timeout: 30_000,
};

async function git(args: string[]): Promise<Buffer> {
  const result = await exec('git', ['-c', 'core.fsmonitor=false', ...args], {
    ...gitOptions,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
  return result.stdout as Buffer;
}
function decodePaths(output: Buffer): string[] {
  const paths: string[] = [];
  for (const path of output.toString('binary').split('\0')) {
    if (!path) continue;
    try {
      paths.push(decoder.decode(Buffer.from(path, 'binary')));
    } catch {
      // The physical walk reports non-UTF-8 names as unpublishable.
    }
  }
  return paths;
}
function displayInvalid(bytes: Buffer): string {
  return Array.from(
    bytes,
    (byte) => `\\x${byte.toString(16).padStart(2, '0')}`
  ).join('');
}

/** Enumerate only regular files under root. Names remain display data, never shell text. */
export async function walkFolder(root: string): Promise<FolderWalkResult> {
  const leftOut: FolderOmission[] = [];
  const physical = new Map<
    string,
    { kind: 'file' | 'directory' | 'symlink' | 'other'; size: number }
  >();
  let hasIgnore = false;
  async function walk(dir: Buffer, relative: string): Promise<void> {
    const names = await readdir(dir, { encoding: 'buffer' });
    names.sort(Buffer.compare);
    for (const name of names) {
      let text: string;
      try {
        text = decoder.decode(name);
      } catch {
        leftOut.push({
          path: relative
            ? `${relative}/${displayInvalid(name)}`
            : displayInvalid(name),
          reason: 'unpublishable_name',
        });
        continue;
      }
      const path = relative ? `${relative}/${text}` : text;
      const full = Buffer.concat([dir, Buffer.from('/'), name]);
      if (text === '.git' || text === 'node_modules') {
        leftOut.push({
          path,
          reason: text === '.git' ? 'git_metadata' : 'node_modules',
        });
        continue;
      }
      const info = await lstat(full);
      if (text === '.DS_Store' && info.isFile()) {
        leftOut.push({ path, reason: 'os_metadata' });
        continue;
      }
      if (info.isSymbolicLink()) {
        leftOut.push({ path, reason: 'symlink' });
        continue;
      }
      if (!info.isDirectory() && !info.isFile()) {
        leftOut.push({ path, reason: 'not_regular_file' });
        continue;
      }
      const canonical = normaliseEntryPath(path);
      if (!canonical.ok) {
        leftOut.push({
          path,
          reason:
            canonical.rule === 'too_deep'
              ? 'path_too_deep'
              : canonical.rule === 'path_too_long' ||
                  canonical.rule === 'segment_too_long'
                ? 'path_too_long'
                : 'unpublishable_name',
        });
        continue;
      }
      if (text === '.gitignore' && info.isFile()) hasIgnore = true;
      physical.set(path, {
        kind: info.isDirectory() ? 'directory' : 'file',
        size: info.size,
      });
      if (info.isDirectory()) await walk(full, path);
    }
  }
  await walk(Buffer.from(root), '');

  let inGit = false;
  try {
    inGit =
      (await git(['-C', root, 'rev-parse', '--is-inside-work-tree']))
        .toString()
        .trim() === 'true';
  } catch (error) {
    let directory = root;
    while (true) {
      const marker = await lstat(join(directory, '.git')).catch(
        () => undefined
      );
      if (marker)
        return {
          ok: false,
          code: 'gitignore_unavailable',
          details: { error: String(error) },
        };
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  let candidate: Set<string> | undefined;
  let ignored: string[] = [];
  let temp: string | undefined;
  if (inGit || hasIgnore) {
    try {
      let prefix: string[];
      if (inGit) prefix = ['-C', root];
      else {
        temp = await mkdtemp(join(tmpdir(), 'relic-ignore-'));
        await git(['init', '--bare', '-q', temp]);
        prefix = [`--git-dir=${temp}`, `--work-tree=${root}`];
      }
      candidate = new Set(
        decodePaths(
          await git([
            ...prefix,
            'ls-files',
            '-z',
            '--cached',
            '--others',
            '--exclude-standard',
            '--',
            '.',
          ])
        )
      );
      ignored = decodePaths(
        await git([
          ...prefix,
          'ls-files',
          '-z',
          '--others',
          '--ignored',
          '--exclude-standard',
          '--directory',
          '--',
          '.',
        ])
      );
    } catch (error) {
      return {
        ok: false,
        code: 'gitignore_unavailable',
        details: { error: String(error) },
      };
    } finally {
      if (temp) await rm(temp, { recursive: true, force: true });
    }
  }
  const ignoredSet = new Set(ignored.map((path) => path.replace(/\/$/, '')));
  for (const path of ignoredSet) {
    const first = path
      .split('/')
      .find((part) => part === '.git' || part === 'node_modules');
    if (!first && !leftOut.some((entry) => entry.path === path))
      leftOut.push({ path, reason: 'gitignore' });
  }
  const underIgnored = (path: string) =>
    [...ignoredSet].some(
      (item) => path === item || path.startsWith(`${item}/`)
    );
  const files: FolderFile[] = [];
  for (const [path, info] of physical) {
    if (underIgnored(path)) continue;
    if (candidate && !candidate.has(path) && !candidate.has(`${path}/`))
      continue;
    if (info.kind === 'directory') {
      if (candidate?.has(`${path}/`))
        leftOut.push({ path, reason: 'nested_repository' });
      continue;
    }
    const normalized = normaliseEntryPath(path);
    if (normalized.ok)
      files.push({ path: normalized.path, sourcePath: path, size: info.size });
  }
  if (candidate)
    for (const path of candidate) {
      const clean = path.replace(/\/$/, '');
      if (
        !physical.has(clean) &&
        !leftOut.some((entry) => entry.path === clean) &&
        !underIgnored(clean)
      )
        leftOut.push({ path: clean, reason: 'missing' });
      else if (physical.get(clean)?.kind === 'directory' && !path.endsWith('/'))
        leftOut.push({ path: clean, reason: 'submodule' });
    }
  files.sort((a, b) => compareEntryPaths(a.path, b.path));
  const check = checkEntrySet(files.map((file) => file.path));
  if (!check.ok)
    return {
      ok: false,
      code: 'path_collision',
      details: { rule: check.rule, paths: check.paths },
    };
  if (files.length > MAX_ENTRIES)
    return {
      ok: false,
      code: 'too_many_files',
      details: { file_count: files.length, limit: MAX_ENTRIES },
    };
  if (!files.length)
    return {
      ok: false,
      code: leftOut.length ? 'all-excluded' : 'folder_empty',
      details: { left_out: leftOut },
    };
  leftOut.sort((a, b) => compareEntryPaths(a.path, b.path));
  return { ok: true, files, leftOut };
}
