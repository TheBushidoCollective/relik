import { basename } from 'node:path';
import {
  chooseDefaultEntry,
  deriveRendererClass,
  encodeManifest,
  guessMimetype,
  MAX_MANIFEST_BYTES,
  PLAINTEXT_CAP_BYTES,
  RENDERABLE_CLASSES,
  type FolderByteSource,
} from '@relic/format';
import type { ConfinedBundleDirectory } from './publish.ts';
import type { FolderFile } from './folder-source.ts';

export class FolderContentError extends Error {
  constructor(
    readonly code:
      | 'file_changed_during_publish'
      | 'file_list_too_large'
      | 'local_size_precheck_failed'
      | 'open_first_not_found',
    readonly details: Readonly<Record<string, unknown>>
  ) {
    super(code);
  }
}

export interface PreparedFolderEntry {
  readonly path: string;
  readonly mimetype: string;
  readonly bytes: FolderByteSource;
}
export interface PreparedFolder {
  readonly entries: readonly PreparedFolderEntry[];
  readonly defaultIndex: number;
  readonly manifest: Uint8Array;
  readonly filesTotalBytes: number;
  readonly contentLength: number;
}

/** Read one held regular file at a time. No source path is reopened outside the pinned root. */
export async function prepareFolderContent(
  root: ConfinedBundleDirectory,
  files: readonly FolderFile[],
  openFirst?: string
): Promise<PreparedFolder> {
  const entries: PreparedFolderEntry[] = [];
  const renderable: { path: string; renderable: boolean }[] = [];
  let filesTotalBytes = 0;
  for (const file of files) {
    const held = await root.openRegular(file.sourcePath);
    try {
      if (held.size !== file.size)
        throw new FolderContentError('file_changed_during_publish', {
          path: file.path,
          expected: file.size,
          actual: held.size,
        });
      filesTotalBytes += held.size;
    } finally {
      await held.close();
    }
  }
  const minimumListBytes =
    4 + files.reduce((sum, file) => sum + 12 + Buffer.byteLength(file.path), 0);
  if (
    !Number.isSafeInteger(filesTotalBytes) ||
    filesTotalBytes + minimumListBytes > PLAINTEXT_CAP_BYTES
  )
    throw new FolderContentError('local_size_precheck_failed', {
      size_limit_bytes: PLAINTEXT_CAP_BYTES,
      declared_size_bytes: filesTotalBytes + minimumListBytes,
      files_total_bytes: filesTotalBytes,
      file_list_bytes: minimumListBytes,
      size_basis: 'plaintext',
    });
  for (const file of files) {
    const held = await root.openRegular(file.sourcePath);
    let sample: Uint8Array;
    try {
      if (held.size !== file.size)
        throw new FolderContentError('file_changed_during_publish', {
          path: file.path,
          expected: file.size,
          actual: held.size,
        });
      sample = new Uint8Array(held.size);
      await held.readInto(sample);
    } finally {
      await held.close();
    }
    const cls = deriveRendererClass(sample, basename(file.path));
    const mimetype = guessMimetype(basename(file.path), cls);
    renderable.push({
      path: file.path,
      renderable: RENDERABLE_CLASSES.includes(cls),
    });
    entries.push({
      path: file.path,
      mimetype,
      bytes: {
        size: file.size,
        async *chunks() {
          const opened = await root.openRegular(file.sourcePath);
          try {
            if (opened.size !== file.size)
              throw new FolderContentError('file_changed_during_publish', {
                path: file.path,
                expected: file.size,
                actual: opened.size,
              });
            const buffer = new Uint8Array(opened.size);
            try {
              await opened.readInto(buffer);
            } catch (cause) {
              throw new FolderContentError('file_changed_during_publish', {
                path: file.path,
                cause: String(cause),
              });
            }
            const chunkSize = 1024 * 1024;
            for (let offset = 0; offset < buffer.length; offset += chunkSize)
              yield buffer.subarray(
                offset,
                Math.min(offset + chunkSize, buffer.length)
              );
          } finally {
            await opened.close();
          }
        },
      },
    });
  }
  const selected = chooseDefaultEntry(renderable, openFirst?.normalize('NFC'));
  if (!selected.ok)
    throw new FolderContentError('open_first_not_found', {
      open_first: openFirst,
    });
  const listBytes =
    4 +
    entries.reduce(
      (sum, entry) =>
        sum +
        12 +
        Buffer.byteLength(entry.path) +
        Buffer.byteLength(entry.mimetype),
      0
    );
  if (listBytes > MAX_MANIFEST_BYTES)
    throw new FolderContentError('file_list_too_large', {
      file_list_bytes: listBytes,
      limit: MAX_MANIFEST_BYTES,
    });
  const contentLength = filesTotalBytes + listBytes;
  if (contentLength > PLAINTEXT_CAP_BYTES)
    throw new FolderContentError('local_size_precheck_failed', {
      size_limit_bytes: PLAINTEXT_CAP_BYTES,
      declared_size_bytes: contentLength,
      files_total_bytes: filesTotalBytes,
      file_list_bytes: listBytes,
      size_basis: 'plaintext',
    });
  const manifest = encodeManifest(
    selected.index,
    entries.map((entry) => ({
      path: entry.path,
      mimetype: entry.mimetype,
      length: entry.bytes.size,
    }))
  );
  return {
    entries,
    defaultIndex: selected.index,
    manifest,
    filesTotalBytes,
    contentLength,
  };
}
