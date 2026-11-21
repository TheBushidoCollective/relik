import {
  createIgnoreMatcher,
  IgnoreLimitError,
  MAX_ENTRIES,
  MAX_IGNORE_RULES,
  MAX_PATH_DEPTH,
  normaliseEntryPath,
} from '@relic/format';
import {
  abortable,
  prepareBrowserFolder,
  PublishSourceFailure,
  reservedSegmentReason,
  rethrowAbort,
  throwIfAborted,
  type BrowserFolder,
  type BrowserFolderFile,
  type BrowserOmission,
} from './browser-folder-preflight.ts';

export const MAX_BROWSER_DIRECTORY_ENTRIES = 50_000;
export const MAX_BROWSER_IGNORE_BYTES = 1024 * 1024;
export const MAX_BROWSER_IGNORE_RULES = MAX_IGNORE_RULES;
export const MAX_BROWSER_IGNORE_WORK = 2_000_000_000;
const MAX_BROWSER_IGNORE_MATCH_WORK = 1_000_000;
const encoder = new TextEncoder();

type PickerEntry =
  | { name: string; kind: 'directory'; children: PickerEntry[] }
  | { name: string; kind: 'file'; file: File };

async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, 0);
  await abortable(promise, signal);
  throwIfAborted(signal);
}

/** DirectoryReader yields batches, not the entire directory in its first call. */
async function children(
  dir: FileSystemDirectoryEntry,
  reserve: (count: number) => void,
  signal?: AbortSignal
): Promise<FileSystemEntry[]> {
  throwIfAborted(signal);
  const reader = dir.createReader();
  const entries: FileSystemEntry[] = [];
  for (;;) {
    throwIfAborted(signal);
    const { promise, resolve, reject } =
      Promise.withResolvers<FileSystemEntry[]>();
    reader.readEntries(resolve, reject);
    const batch = await abortable(promise, signal);
    throwIfAborted(signal);
    if (!batch.length) return entries;
    reserve(batch.length);
    for (const entry of batch) {
      throwIfAborted(signal);
      entries.push(entry);
      if (entries.length % 1000 === 0) await yieldToEventLoop(signal);
    }
  }
}

async function entryFile(
  entry: FileSystemFileEntry,
  path: string,
  signal?: AbortSignal
): Promise<File> {
  try {
    throwIfAborted(signal);
    const { promise, resolve, reject } = Promise.withResolvers<File>();
    entry.file(resolve, reject);
    const file = await abortable(promise, signal);
    throwIfAborted(signal);
    return file;
  } catch (error) {
    rethrowAbort(error, signal);
    throw new Error(
      `Could not read ${path}. Check that it is available on this device.`
    );
  }
}

export async function prepareBrowserDirectory(
  entries: readonly FileSystemEntry[],
  pickedFiles: readonly File[],
  options: { readonly signal?: AbortSignal } = {}
): Promise<BrowserFolder> {
  const { signal } = options;
  throwIfAborted(signal);
  const leftOut: BrowserOmission[] = [];
  const omittedPaths = new Set<string>();
  const included: { path: string; file: File }[] = [];
  const matcher = createIgnoreMatcher([], {
    maxWork: MAX_BROWSER_IGNORE_WORK,
    maxMatchWork: MAX_BROWSER_IGNORE_MATCH_WORK,
  });
  let visited = 0;
  let processed = 0;
  let ignoreBytes = 0;
  let decodedBytes = 0;
  const reserve = (count: number) => {
    if (count > MAX_BROWSER_DIRECTORY_ENTRIES - visited)
      throw new PublishSourceFailure(
        'too_many_files',
        `The folder has too many entries to review. The limit is ${MAX_BROWSER_DIRECTORY_ENTRIES}.`,
        { limit: MAX_BROWSER_DIRECTORY_ENTRIES }
      );
    visited += count;
  };
  const checkpoint = () => {
    throwIfAborted(signal);
    return ++processed % 1000 === 0;
  };
  const omit = (path: string, reason: string) => {
    if (!omittedPaths.has(path)) {
      omittedPaths.add(path);
      leftOut.push({ path, reason });
    }
  };
  const checkPath = (path: string, depth: number) => {
    if (depth > MAX_PATH_DEPTH)
      throw new PublishSourceFailure(
        'source_unreadable',
        `The folder is nested too deeply. File paths may have at most ${MAX_PATH_DEPTH} segments.`,
        { limit: MAX_PATH_DEPTH }
      );
    const result = normaliseEntryPath(path);
    if (!result.ok)
      throw new PublishSourceFailure(
        'source_unreadable',
        `Invalid file path ${path}: ${result.rule.replaceAll('_', ' ')} (${result.rule}).`,
        { name: path, rule: result.rule }
      );
  };
  const convertIgnoreError = (error: unknown): never => {
    if (error instanceof IgnoreLimitError)
      throw new PublishSourceFailure('source_unreadable', error.message, {
        limit: error.limit,
        kind: error.kind,
      });
    throw error;
  };
  const isIgnored = (path: string, directory: boolean): boolean => {
    try {
      return matcher(path, directory);
    } catch (error) {
      return convertIgnoreError(error);
    }
  };
  async function loadIgnore(
    file: File,
    path: string,
    dir: string
  ): Promise<void> {
    throwIfAborted(signal);
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_BROWSER_IGNORE_BYTES - ignoreBytes
    )
      throw new PublishSourceFailure(
        'source_unreadable',
        `The folder's ignore files exceed the ${MAX_BROWSER_IGNORE_BYTES}-byte review limit.`,
        { limit: MAX_BROWSER_IGNORE_BYTES }
      );
    ignoreBytes += file.size;
    let text: string;
    try {
      text = await abortable(file.text(), signal);
      throwIfAborted(signal);
    } catch (error) {
      rethrowAbort(error, signal);
      throw new PublishSourceFailure(
        'source_unreadable',
        `Could not read ${path}. Ignore rules cannot be applied safely.`
      );
    }
    decodedBytes += encoder.encode(text).length;
    if (decodedBytes > MAX_BROWSER_IGNORE_BYTES)
      throw new PublishSourceFailure(
        'source_unreadable',
        `The folder's ignore files exceed the ${MAX_BROWSER_IGNORE_BYTES}-byte review limit.`,
        { limit: MAX_BROWSER_IGNORE_BYTES }
      );
    try {
      matcher.add({ dir, text });
    } catch (error) {
      convertIgnoreError(error);
    }
  }
  const reserveFile = () => {
    if (included.length >= MAX_ENTRIES)
      throw new PublishSourceFailure(
        'too_many_files',
        `Too many files. The limit is ${MAX_ENTRIES}.`,
        { limit: MAX_ENTRIES }
      );
  };

  async function walkDrop(
    list: readonly FileSystemEntry[],
    parent: string
  ): Promise<void> {
    const ignoreFiles = new Map<FileSystemEntry, File>();
    for (const entry of list) {
      if (checkpoint()) await yieldToEventLoop(signal);
      if (entry.name !== '.gitignore' || !entry.isFile) continue;
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      let file: File;
      try {
        file = await entryFile(entry as FileSystemFileEntry, path, signal);
      } catch (error) {
        rethrowAbort(error, signal);
        throw new PublishSourceFailure(
          'source_unreadable',
          `Could not read ${path}. Ignore rules cannot be applied safely.`
        );
      }
      ignoreFiles.set(entry, file);
      await loadIgnore(file, path, parent);
    }
    for (const entry of list) {
      if (checkpoint()) await yieldToEventLoop(signal);
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      const reason = reservedSegmentReason(entry.name);
      if (reason) {
        omit(path, reason);
        continue;
      }
      if (isIgnored(path, entry.isDirectory)) {
        omit(path, 'gitignore');
        continue;
      }
      checkPath(path, parent ? parent.split('/').length + 1 : 1);
      if (entry.isDirectory) {
        let list: FileSystemEntry[];
        try {
          list = await children(
            entry as FileSystemDirectoryEntry,
            reserve,
            signal
          );
        } catch (error) {
          rethrowAbort(error, signal);
          if (error instanceof PublishSourceFailure) throw error;
          omit(path, 'unreadable');
          continue;
        }
        await walkDrop(list, path);
      } else if (entry.isFile) {
        reserveFile();
        try {
          const file =
            ignoreFiles.get(entry) ??
            (await entryFile(entry as FileSystemFileEntry, path, signal));
          included.push({ path, file });
        } catch (error) {
          rethrowAbort(error, signal);
          omit(path, 'unreadable');
        }
      } else omit(path, 'not_regular_file');
    }
  }

  async function walkPicker(
    list: readonly PickerEntry[],
    parent: string
  ): Promise<void> {
    for (const entry of list) {
      if (checkpoint()) await yieldToEventLoop(signal);
      if (entry.name !== '.gitignore' || entry.kind !== 'file') continue;
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      await loadIgnore(entry.file, path, parent);
    }
    for (const entry of list) {
      if (checkpoint()) await yieldToEventLoop(signal);
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      const reason = reservedSegmentReason(entry.name);
      if (reason) {
        omit(path, reason);
        continue;
      }
      const directory = entry.kind === 'directory';
      if (isIgnored(path, directory)) {
        omit(path, 'gitignore');
        continue;
      }
      checkPath(path, parent ? parent.split('/').length + 1 : 1);
      if (entry.kind === 'directory') await walkPicker(entry.children, path);
      else {
        reserveFile();
        included.push({ path, file: entry.file });
      }
    }
  }

  let name =
    entries[0]?.name ??
    pickedFiles[0]?.webkitRelativePath.split('/')[0] ??
    'Folder';
  if (entries.length === 1 && entries[0]?.isDirectory) {
    const root = entries[0];
    const reason = reservedSegmentReason(root.name);
    if (reason) omit(root.name, reason);
    else {
      let list: FileSystemEntry[];
      try {
        list = await children(
          root as FileSystemDirectoryEntry,
          reserve,
          signal
        );
      } catch (error) {
        rethrowAbort(error, signal);
        if (error instanceof PublishSourceFailure) throw error;
        throw new Error(
          `Could not read ${root.name}. Check folder permissions.`
        );
      }
      await walkDrop(list, '');
    }
  } else if (entries.length) {
    name = 'Folder';
    reserve(entries.length);
    await walkDrop(entries, '');
  } else {
    const rootName = pickedFiles[0]?.webkitRelativePath.split('/')[0];
    const rootReason = rootName && reservedSegmentReason(rootName);
    if (rootName && rootReason) omit(rootName, rootReason);
    else {
      const root: PickerEntry[] = [];
      const directories = new Map<
        string,
        PickerEntry & { kind: 'directory' }
      >();
      for (const file of pickedFiles) {
        if (checkpoint()) await yieldToEventLoop(signal);
        const relative = file.webkitRelativePath.split('/');
        const selectedRoot = relative.shift() ?? '';
        const reason = reservedSegmentReason(selectedRoot);
        if (reason) {
          omit(selectedRoot, reason);
          continue;
        }
        let list = root;
        let path = '';
        for (let i = 0; i < relative.length; i++) {
          if (checkpoint()) await yieldToEventLoop(signal);
          const part = relative[i]!;
          path = path ? `${path}/${part}` : part;
          if (i === relative.length - 1) {
            reserve(1);
            list.push({ name: part, kind: 'file', file });
          } else {
            let directory = directories.get(path);
            if (!directory) {
              reserve(1);
              directory = { name: part, kind: 'directory', children: [] };
              directories.set(path, directory);
              list.push(directory);
            }
            list = directory.children;
          }
        }
      }
      await walkPicker(root, '');
    }
  }

  const files: BrowserFolderFile[] = [];
  for (const item of included) {
    if (checkpoint()) await yieldToEventLoop(signal);
    const file = item.file;
    files.push({
      path: item.path,
      size: file.size,
      async read() {
        throwIfAborted(signal);
        const bytes = new Uint8Array(
          await abortable(file.arrayBuffer(), signal)
        );
        throwIfAborted(signal);
        return bytes;
      },
      async *chunks() {
        try {
          for (let offset = 0; offset < file.size; offset += 1024 * 1024) {
            throwIfAborted(signal);
            const bytes = new Uint8Array(
              await abortable(
                file.slice(offset, offset + 1024 * 1024).arrayBuffer(),
                signal
              )
            );
            throwIfAborted(signal);
            yield bytes;
          }
        } catch (error) {
          rethrowAbort(error, signal);
          throw new Error(
            `Could not read ${item.path}. Check that it is available on this device.`
          );
        }
      },
    });
  }
  return prepareBrowserFolder(
    name,
    'directory',
    files,
    leftOut,
    signal === undefined ? {} : { signal }
  );
}
