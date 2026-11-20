import { realpath } from 'node:fs/promises';
import { normalizeTitle } from '@relic/format';
import {
  folderContentDigest,
  FolderContentError,
  prepareFolderContent,
  type PreparedFolder,
} from './folder-content.ts';
import {
  walkFolder,
  type FolderOmission,
  type FolderWalkResult,
} from './folder-source.ts';
import { PublishError, type FileReader } from './publish.ts';

export interface FolderPublishSource {
  readonly basename: string;
  readonly resolvedPath: string;
  readonly filename: string;
  readonly title: string;
  readonly digest: string;
  readonly folder: PreparedFolder;
  readonly leftOut: readonly FolderOmission[];
  close(): Promise<void>;
}

/** Resolve and validate a folder entirely before the network is contacted. */
export async function prepareFolderPublish(
  path: string,
  files: FileReader,
  filenameOverride?: string,
  titleOverride?: string,
  openFirst?: string
): Promise<FolderPublishSource> {
  const resolvedPath = files.resolve(path);
  const canonicalRoot = await realpath(resolvedPath);
  const root = await files
    .openBundleRoot(canonicalRoot)
    .catch((error: unknown) => {
      const nativeCode = (error as NodeJS.ErrnoException).code;
      throw new PublishError(
        nativeCode?.startsWith('ERR_RELIC_NATIVE_')
          ? 'folder_publish_unsupported_platform'
          : 'source_unreadable',
        'Could not open the folder securely.',
        { native_code: nativeCode }
      );
    });
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await root.close();
    }
  };
  let listing: FolderWalkResult;
  try {
    listing = await walkFolder(canonicalRoot);
  } catch (error) {
    await close();
    throw error;
  }
  if (!listing.ok) {
    await close();
    throw new PublishError(listing.code, listing.code, listing.details);
  }
  const basename = files.basename(resolvedPath);
  const filename = filenameOverride ?? basename;
  const title = normalizeTitle(titleOverride ?? filename);
  try {
    const folder = await prepareFolderContent(root, listing.files, openFirst);
    const digest = await folderContentDigest(folder, filename, title);
    return {
      basename,
      resolvedPath,
      filename,
      title,
      digest,
      folder,
      leftOut: listing.leftOut,
      close,
    };
  } catch (error) {
    await close();
    if (error instanceof FolderContentError)
      throw new PublishError(error.code, error.code, error.details);
    throw error;
  }
}

export async function folderDefaultBytes(
  source: FolderPublishSource
): Promise<Uint8Array> {
  const entry = source.folder.entries[source.folder.defaultIndex]!;
  const output = new Uint8Array(entry.bytes.size);
  let offset = 0;
  try {
    for await (const chunk of entry.bytes.chunks()) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
  } catch (error) {
    if (error instanceof FolderContentError)
      throw new PublishError(error.code, error.code, error.details);
    throw error;
  }
  if (offset !== output.length)
    throw new PublishError(
      'file_changed_during_publish',
      'The file changed while being read.',
      { path: entry.path }
    );
  return output;
}

export function folderReport(source: FolderPublishSource) {
  const byReason: Partial<Record<FolderOmission['reason'], number>> = {};
  for (const entry of source.leftOut)
    byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
  return {
    source: 'directory' as const,
    file_count: source.folder.entries.length,
    files_total_bytes: source.folder.filesTotalBytes,
    file_list_bytes: source.folder.manifest.length,
    default_entry: source.folder.entries[source.folder.defaultIndex]!.path,
    sample: source.folder.entries.slice(0, 20).map((entry) => entry.path),
    left_out: {
      count: source.leftOut.length,
      by_reason: byReason,
      sample: source.leftOut.slice(0, 50),
    },
  };
}
