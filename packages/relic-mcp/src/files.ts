/** Filesystem access through Node, kept behind the FileReader interface. */

import { lstat, readFile } from 'node:fs/promises';
import { basename as pathBasename, resolve as pathResolve } from 'node:path';
import {
  type NativeBundleRoot,
  type NativeOpenedRegularFile,
  openNativeBundleRoot,
} from './native-secure-open.ts';
import type {
  ConfinedBundleDirectory,
  ConfinedBundleFile,
  FileReader,
} from './publish.ts';

function confinedFile(file: NativeOpenedRegularFile): ConfinedBundleFile {
  return {
    size: file.size,
    readBounded(maxBytes) {
      return file.read(maxBytes);
    },
    close() {
      return file.close();
    },
  };
}

function confinedDirectory(root: NativeBundleRoot): ConfinedBundleDirectory {
  return {
    async openRegular(relativePath) {
      return confinedFile(await root.openRegular(relativePath));
    },
    close() {
      return root.close();
    },
  };
}

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

  async openBundleRoot(path) {
    return confinedDirectory(await openNativeBundleRoot(path));
  },
};
