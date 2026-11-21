import { indexZip, MAX_ENTRIES, type ZipRefusal } from '@relic/format';
import {
  BROWSER_PUBLISH_LIMIT_BYTES,
  prepareBrowserFolder,
  PublishSourceFailure,
  requireBoundedSize,
  type BrowserFolder,
  type BrowserFolderFile,
  type BrowserOmission,
} from './browser-folder-preflight.ts';

function zipFailure(refusal: ZipRefusal): PublishSourceFailure {
  return new PublishSourceFailure(
    'zip_invalid',
    `${refusal.message} (${refusal.reason}). Publish as one file instead.`,
    { reason: refusal.reason }
  );
}

/** Index the archive through File slices, validating each entry before publication. */
export async function prepareBrowserZip(
  file: File,
  options: { readonly filename?: string; readonly openFirst?: string } = {}
): Promise<BrowserFolder> {
  requireBoundedSize(file.size);
  if (!/\.zip$/i.test(file.name)) {
    throw new PublishSourceFailure(
      'zip_not_supported',
      'Only a selected ZIP file can be expanded into a folder.'
    );
  }
  const index = await indexZip(
    {
      size: file.size,
      async read(start, end) {
        try {
          return new Uint8Array(await file.slice(start, end).arrayBuffer());
        } catch {
          throw new Error(
            `Could not read ${file.name}. Check that it is available on this device.`
          );
        }
      },
    },
    {
      maxArchiveBytes: BROWSER_PUBLISH_LIMIT_BYTES,
      maxEntries: MAX_ENTRIES,
      maxEntryBytes: BROWSER_PUBLISH_LIMIT_BYTES,
      maxTotalBytes: BROWSER_PUBLISH_LIMIT_BYTES,
    }
  );
  if (!index.ok) throw zipFailure(index);
  const files: BrowserFolderFile[] = [];
  const leftOut: BrowserOmission[] = [];
  for (const entry of index.index.entries.values()) {
    const parts = entry.name.split('/');
    const reason =
      entry.kind === 'directory'
        ? 'directory'
        : parts.includes('__MACOSX') ||
            parts.some((part) => part === '.DS_Store' || part.startsWith('._'))
          ? 'os_metadata'
          : parts.includes('.git')
            ? 'git_metadata'
            : parts.includes('node_modules')
              ? 'node_modules'
              : entry.kind === 'symlink'
                ? 'symlink'
                : undefined;
    if (reason) {
      leftOut.push({ path: entry.name, reason });
      continue;
    }
    const read = async (): Promise<Uint8Array> => {
      const result = await index.index.read(entry.name);
      if (!result.ok) throw zipFailure(result);
      return result.bytes;
    };
    files.push({
      path: entry.name,
      size: entry.size,
      read,
      async *chunks() {
        yield await read();
      },
    });
  }
  return prepareBrowserFolder(
    options.filename ?? file.name.replace(/\.zip$/i, ''),
    'zip',
    files,
    leftOut,
    options.openFirst
  );
}
