import {
  checkEntrySet,
  chooseDefaultEntry,
  compareEntryPaths,
  deriveRendererClass,
  folderPlaintext,
  guessMimetype,
  MAX_ENTRIES,
  normaliseEntryPath,
  RENDERABLE_CLASSES,
  type FolderByteSource,
} from '@relic/format';
import { BROWSER_PUBLISH_LIMIT_BYTES } from './publish.ts';

export interface BrowserOmission {
  readonly path: string;
  readonly reason: string;
}
export interface BrowserFolderFile {
  readonly path: string;
  readonly size: number;
  read(): Promise<Uint8Array>;
  chunks(): AsyncIterable<Uint8Array>;
}
export interface BrowserFolder {
  readonly name: string;
  readonly source: 'zip' | 'directory';
  readonly entries: readonly {
    path: string;
    mimetype: string;
    bytes: FolderByteSource;
  }[];
  readonly defaultIndex: number;
  readonly totalBytes: number;
  readonly contentLength: number;
  readonly leftOut: readonly BrowserOmission[];
}

export async function prepareBrowserFolder(
  name: string,
  source: 'zip' | 'directory',
  files: BrowserFolderFile[],
  leftOut: BrowserOmission[]
): Promise<BrowserFolder> {
  const fix = source === 'zip' ? ' Publish as one file instead.' : '';
  const normalized = files.map((file) => {
    const result = normaliseEntryPath(file.path);
    if (!result.ok)
      throw new Error(
        `Invalid file path ${file.path}: ${result.rule.replaceAll('_', ' ')} (${result.rule}).${fix}`
      );
    return { ...file, path: result.path };
  });
  normalized.sort((a, b) => compareEntryPaths(a.path, b.path));
  if (normalized.length > MAX_ENTRIES)
    throw new Error(`Too many files. The limit is ${MAX_ENTRIES}.${fix}`);
  if (!normalized.length)
    throw new Error(
      `${leftOut.length ? 'All files were excluded' : 'The folder is empty'}.${fix}`
    );
  const checked = checkEntrySet(normalized.map((file) => file.path));
  if (!checked.ok)
    throw new Error(
      `File paths collide (${checked.rule}): ${checked.paths.join(', ')}.${fix}`
    );
  const totalBytes = normalized.reduce((sum, file) => sum + file.size, 0);
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes > BROWSER_PUBLISH_LIMIT_BYTES
  )
    throw new Error(`Files exceed this page's 100 MB limit.${fix}`);
  const entries: { path: string; mimetype: string; bytes: FolderByteSource }[] =
    [];
  const renderable: { path: string; renderable: boolean }[] = [];
  for (const file of normalized) {
    let sample: Uint8Array;
    try {
      sample = await file.read();
    } catch (error) {
      throw new Error(
        `Could not read ${file.path}: ${error instanceof Error ? error.message : 'file unavailable'}.${fix}`
      );
    }
    const basename = file.path.split('/').pop() ?? file.path;
    const cls = deriveRendererClass(sample, basename);
    renderable.push({
      path: file.path,
      renderable: RENDERABLE_CLASSES.includes(cls),
    });
    entries.push({
      path: file.path,
      mimetype: guessMimetype(basename, cls),
      bytes: { size: file.size, chunks: file.chunks },
    });
  }
  const selected = chooseDefaultEntry(renderable);
  if (!selected.ok) throw new Error(`Could not choose the first file.${fix}`);
  let contentLength: number;
  try {
    contentLength = folderPlaintext({
      name,
      defaultIndex: selected.index,
      entries,
    }).header.contentLength;
  } catch (error) {
    throw new Error(
      `Cannot publish the file list: ${error instanceof Error ? error.message : 'invalid folder'}.${fix}`
    );
  }
  if (contentLength > BROWSER_PUBLISH_LIMIT_BYTES)
    throw new Error(
      `Files and their list exceed this page's 100 MB limit.${fix}`
    );
  return {
    name,
    source,
    entries,
    defaultIndex: selected.index,
    totalBytes,
    contentLength,
    leftOut,
  };
}
