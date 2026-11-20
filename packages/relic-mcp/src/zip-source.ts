import { inflateRawSync } from 'node:zlib';
import {
  checkEntrySet,
  compareEntryPaths,
  indexZip,
  MAX_ENTRIES,
  normaliseEntryPath,
  normalizeTitle,
  PLAINTEXT_CAP_BYTES,
  type ZipRefusal,
} from '@relic/format';
import {
  folderContentDigest,
  FolderContentError,
  prepareFolderContent,
} from './folder-content.ts';
import type { FolderPublishSource } from './folder-publish-source.ts';
import type { FolderFile, FolderOmission } from './folder-source.ts';
import {
  PublishError,
  readSource,
  type ConfinedBundleDirectory,
  type FileReader,
} from './publish.ts';

const fix = 'Publish it as one file with expand: false.';

function zipError(refusal: ZipRefusal): PublishError {
  const codes = {
    encrypted: 'zip_encrypted',
    zip64: 'zip_unsupported',
    'multi-disk': 'zip_unsupported',
    duplicate: 'zip_duplicate',
    'unsafe-name': 'zip_unsafe_name',
    'bad-name-encoding': 'zip_name_not_utf8',
    'too-many-entries': 'zip_too_many_entries',
    'directory-too-large': 'zip_unsupported',
    'entry-too-large': 'zip_expands_too_large',
    'total-too-large': 'zip_expands_too_large',
    'crc-mismatch': 'zip_corrupt',
    'size-mismatch': 'zip_corrupt',
    'unsupported-method': 'zip_unsupported',
    'not-a-file': 'zip_corrupt',
    corrupt: 'zip_corrupt',
  } as const;
  return new PublishError(codes[refusal.reason], `${refusal.message}. ${fix}`, {
    reason: refusal.reason,
  });
}

/** Index once, then materialize at most one entry at a time through the folder writer. */
export async function prepareZipPublish(
  path: string,
  files: FileReader,
  filenameOverride?: string,
  titleOverride?: string,
  openFirst?: string
): Promise<FolderPublishSource> {
  const source = await readSource(path, files);
  const result = await indexZip(
    source.bytes,
    {
      maxArchiveBytes: PLAINTEXT_CAP_BYTES,
      maxEntries: 20000,
      maxEntryBytes: PLAINTEXT_CAP_BYTES,
      maxTotalBytes: PLAINTEXT_CAP_BYTES,
    },
    async (compressed, _size, limit) => {
      const output = inflateRawSync(compressed, {
        maxOutputLength: Math.max(1, limit),
      });
      return new Uint8Array(
        output.buffer,
        output.byteOffset,
        output.byteLength
      );
    }
  );
  if (!result.ok) throw zipError(result);
  const listing: FolderFile[] = [];
  const leftOut: FolderOmission[] = [];
  for (const entry of result.index.entries.values()) {
    if (entry.kind === 'directory') continue;
    const segments = entry.name.split('/');
    const omit =
      segments.includes('__MACOSX') ||
      segments.some((s) => s === '.DS_Store' || s.startsWith('._'))
        ? 'os_metadata'
        : segments.includes('.git')
          ? 'git_metadata'
          : segments.includes('node_modules')
            ? 'node_modules'
            : entry.kind === 'symlink'
              ? 'symlink'
              : undefined;
    if (omit) {
      leftOut.push({ path: entry.name, reason: omit });
      continue;
    }
    const name = normaliseEntryPath(entry.name);
    if (!name.ok)
      throw new PublishError(
        'zip_unsafe_name',
        `Invalid ZIP entry name (${name.rule}). ${fix}`,
        { name: entry.name, rule: name.rule }
      );
    listing.push({ path: name.path, sourcePath: entry.name, size: entry.size });
  }
  listing.sort((a, b) => compareEntryPaths(a.path, b.path));
  const checked = checkEntrySet(listing.map((entry) => entry.path));
  if (!checked.ok)
    throw new PublishError(
      'path_collision',
      `ZIP entry paths collide. ${fix}`,
      { rule: checked.rule, paths: checked.paths }
    );
  if (listing.length > MAX_ENTRIES)
    throw new PublishError('too_many_files', `ZIP has too many files. ${fix}`, {
      file_count: listing.length,
      limit: MAX_ENTRIES,
    });
  if (!listing.length)
    throw new PublishError(
      'folder_empty',
      `ZIP contains no publishable files. ${fix}`,
      { left_out: leftOut }
    );
  for (const entry of listing) {
    const verified = await result.index.read(entry.sourcePath);
    if (!verified.ok) throw zipError(verified);
  }
  const root: ConfinedBundleDirectory = {
    async openRegular(name) {
      const read = await result.index.read(name);
      if (!read.ok) throw zipError(read);
      const bytes = read.bytes;
      return {
        size: bytes.length,
        async readInto(target) {
          target.set(bytes);
        },
        async close() {},
      };
    },
    async close() {},
  };
  const basename = source.basename.replace(/\.zip$/i, '');
  const filename = filenameOverride ?? basename;
  const title = normalizeTitle(titleOverride ?? filename);
  try {
    const folder = await prepareFolderContent(root, listing, openFirst);
    const digest = await folderContentDigest(folder, filename, title);
    return {
      basename,
      resolvedPath: source.resolvedPath,
      filename,
      title,
      digest,
      folder,
      leftOut,
      source: 'zip',
      close: async () => {},
    };
  } catch (error) {
    if (error instanceof FolderContentError) {
      const cause = error.details['cause'];
      if (cause instanceof PublishError) throw cause;
      throw new PublishError(
        error.code,
        `${error.code}. ${fix}`,
        error.details
      );
    }
    throw error;
  }
}
