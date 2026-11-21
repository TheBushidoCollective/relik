import { createIgnoreMatcher } from '@relic/format';
import {
  prepareBrowserFolder,
  type BrowserFolder,
  type BrowserFolderFile,
  type BrowserOmission,
} from './browser-folder-preflight.ts';

interface Item {
  path: string;
  file?: File;
  directory: boolean;
}

function omitted(name: string): string | undefined {
  if (name === '.git') return 'git_metadata';
  if (name === 'node_modules') return 'node_modules';
  if (name === '.DS_Store' || name === '__MACOSX' || name.startsWith('._'))
    return 'os_metadata';
  return undefined;
}

/** DirectoryReader yields batches, not the entire directory in its first call. */
async function children(
  dir: FileSystemDirectoryEntry
): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    const { promise, resolve, reject } =
      Promise.withResolvers<FileSystemEntry[]>();
    reader.readEntries(resolve, reject);
    const batch = await promise;
    if (!batch.length) return entries;
    entries.push(...batch);
  }
}

async function entryFile(
  entry: FileSystemFileEntry,
  path: string
): Promise<File> {
  try {
    const { promise, resolve, reject } = Promise.withResolvers<File>();
    entry.file(resolve, reject);
    return await promise;
  } catch {
    throw new Error(
      `Could not read ${path}. Check that it is available on this device.`
    );
  }
}

export async function prepareBrowserDirectory(
  entries: readonly FileSystemEntry[],
  pickedFiles: readonly File[]
): Promise<BrowserFolder> {
  const items: Item[] = [];
  const leftOut: BrowserOmission[] = [];
  let name =
    entries[0]?.name ??
    pickedFiles[0]?.webkitRelativePath.split('/')[0] ??
    'Folder';
  async function walk(entry: FileSystemEntry, parent: string): Promise<void> {
    const path = parent ? `${parent}/${entry.name}` : entry.name;
    const reason = omitted(entry.name);
    if (reason) {
      leftOut.push({ path, reason });
      return;
    }
    if (entry.isDirectory) {
      items.push({ path, directory: true });
      let list: FileSystemEntry[];
      try {
        list = await children(entry as FileSystemDirectoryEntry);
      } catch {
        leftOut.push({ path, reason: 'unreadable' });
        return;
      }
      for (const child of list) await walk(child, path);
    } else if (entry.isFile) {
      try {
        items.push({
          path,
          directory: false,
          file: await entryFile(entry as FileSystemFileEntry, path),
        });
      } catch {
        if (entry.name === '.gitignore')
          throw new Error(
            `Could not read ${path}. Ignore rules cannot be applied safely.`
          );
        leftOut.push({ path, reason: 'unreadable' });
      }
    } else leftOut.push({ path, reason: 'not_regular_file' });
  }
  if (entries.length === 1 && entries[0]?.isDirectory) {
    const root = entries[0];
    let list: FileSystemEntry[];
    try {
      list = await children(root as FileSystemDirectoryEntry);
    } catch {
      throw new Error(`Could not read ${root.name}. Check folder permissions.`);
    }
    for (const child of list) await walk(child, '');
  } else if (entries.length) {
    name = 'Folder';
    for (const entry of entries) await walk(entry, '');
  } else {
    const directories = new Set<string>();
    for (const file of pickedFiles) {
      const path = file.webkitRelativePath.split('/').slice(1).join('/');
      const parts = path.split('/');
      let parent = '';
      let skipped = false;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        const current = parent ? `${parent}/${part}` : part;
        const reason = omitted(part);
        if (reason) {
          if (!leftOut.some((item) => item.path === current))
            leftOut.push({ path: current, reason });
          skipped = true;
          break;
        }
        if (i < parts.length - 1 && !directories.has(current)) {
          directories.add(current);
          items.push({ path: current, directory: true });
        }
        parent = current;
      }
      if (!skipped && path) items.push({ path, directory: false, file });
    }
  }
  const ignoreFiles: { dir: string; text: string }[] = [];
  for (const item of items)
    if (item.file && item.path.split('/').pop() === '.gitignore') {
      try {
        ignoreFiles.push({
          dir: item.path.split('/').slice(0, -1).join('/'),
          text: await item.file.text(),
        });
      } catch {
        throw new Error(
          `Could not read ${item.path}. Check that it is available on this device.`
        );
      }
    }
  const ignored = createIgnoreMatcher(ignoreFiles);
  const ignoredDirectories: string[] = [];
  const files: BrowserFolderFile[] = [];
  items.sort((a, b) => a.path.localeCompare(b.path));
  for (const item of items) {
    if (ignoredDirectories.some((dir) => item.path.startsWith(`${dir}/`)))
      continue;
    if (ignored(item.path, item.directory)) {
      leftOut.push({ path: item.path, reason: 'gitignore' });
      if (item.directory) ignoredDirectories.push(item.path);
      continue;
    }
    if (!item.file) continue;
    const file = item.file;
    files.push({
      path: item.path,
      size: file.size,
      async read() {
        return new Uint8Array(await file.arrayBuffer());
      },
      async *chunks() {
        try {
          for (let offset = 0; offset < file.size; offset += 1024 * 1024)
            yield new Uint8Array(
              await file.slice(offset, offset + 1024 * 1024).arrayBuffer()
            );
        } catch {
          throw new Error(
            `Could not read ${item.path}. Check that it is available on this device.`
          );
        }
      },
    });
  }
  return prepareBrowserFolder(name, 'directory', files, leftOut);
}
