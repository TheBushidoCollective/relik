/** Filesystem access through Node, kept behind the FileReader interface. */

import { lstat, readFile } from 'node:fs/promises';
import { basename as pathBasename, resolve as pathResolve } from 'node:path';
import type { FileReader } from './publish.ts';

export const nodeFiles: FileReader = {
  resolve(path) {
    // A relative path resolves against the server process's working
    // directory, and the result is echoed so a publish that picked up the
    // wrong file is diagnosable from the result rather than a support thread.
    return pathResolve(process.cwd(), path);
  },

  basename(path) {
    return pathBasename(path);
  },

  async stat(path) {
    const info = await lstat(path).catch(() => undefined);
    if (info === undefined) return { kind: 'other' };
    if (info.isSymbolicLink()) return { kind: 'symlink' };
    if (info.isDirectory()) return { kind: 'directory' };
    if (!info.isFile()) return { kind: 'other' };
    return { kind: 'file', size: info.size };
  },

  async read(path) {
    return new Uint8Array(await readFile(path));
  },
};
