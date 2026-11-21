import { indexZip, MAX_ENTRIES, type ZipRefusal } from '@relic/format';
import {
  abortable,
  BROWSER_PUBLISH_LIMIT_BYTES,
  prepareBrowserFolder,
  PublishSourceFailure,
  requireBoundedSize,
  reservedSegmentReason,
  rethrowAbort,
  throwIfAborted,
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
  options: {
    readonly filename?: string;
    readonly openFirst?: string;
    readonly signal?: AbortSignal;
  } = {}
): Promise<BrowserFolder> {
  const { signal } = options;
  throwIfAborted(signal);
  requireBoundedSize(file.size);
  if (!/\.zip$/i.test(file.name)) {
    throw new PublishSourceFailure(
      'zip_not_supported',
      'Only a selected ZIP file can be expanded into a folder.'
    );
  }
  let abortError: unknown;
  let abortedRead = false;
  const index = await abortable(
    indexZip(
      {
        size: file.size,
        async read(start, end) {
          try {
            throwIfAborted(signal);
            const bytes = new Uint8Array(
              await abortable(file.slice(start, end).arrayBuffer(), signal)
            );
            throwIfAborted(signal);
            return bytes;
          } catch (error) {
            try {
              rethrowAbort(error, signal);
            } catch (abort) {
              abortedRead = true;
              abortError = abort;
              throw abort;
            }
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
      },
      undefined,
      signal
    ),
    signal
  );
  throwIfAborted(signal);
  if (abortedRead) throw abortError;
  if (!index.ok) throw zipFailure(index);
  const files: BrowserFolderFile[] = [];
  const leftOut: BrowserOmission[] = [];
  for (const entry of index.index.entries.values()) {
    throwIfAborted(signal);
    const reason =
      entry.name.split('/').map(reservedSegmentReason).find(Boolean) ??
      (entry.kind === 'directory'
        ? 'directory'
        : entry.kind === 'symlink'
          ? 'symlink'
          : undefined);
    if (reason) {
      leftOut.push({ path: entry.name, reason });
      continue;
    }
    const read = async (): Promise<Uint8Array> => {
      throwIfAborted(signal);
      const result = await abortable(index.index.read(entry.name), signal);
      throwIfAborted(signal);
      if (abortedRead) throw abortError;
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
    {
      ...(options.openFirst === undefined
        ? {}
        : { openFirst: options.openFirst }),
      ...(signal === undefined ? {} : { signal }),
    }
  );
}
