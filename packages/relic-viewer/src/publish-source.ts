import {
  checkEntrySet,
  chooseDefaultEntry,
  compareEntryPaths,
  deriveRendererClass,
  encodeManifest,
  encryptFolderStream,
  encryptRelic,
  encryptedSize,
  guessMimetype,
  indexZip,
  isRenderable,
  MAX_ENTRIES,
  MAX_FILENAME_BYTES,
  MAX_MANIFEST_BYTES,
  normaliseEntryPath,
  type RendererClass,
  type ZipIndex,
  type ZipRefusal,
} from '@relic/format';

/** The browser caps both the selected input and the plaintext it will publish. */
export const BROWSER_PUBLISH_LIMIT_BYTES = 100_000_000;
const MAX_ZIP_ENTRIES = 20_000;
const encoder = new TextEncoder();

export type PublishSourceFailureCode =
  | 'source_unreadable'
  | 'size_over_cap'
  | 'filename_too_long'
  | 'zip_not_supported'
  | 'zip_invalid'
  | 'folder_empty'
  | 'path_collision'
  | 'too_many_files'
  | 'manifest_too_large'
  | 'open_first_not_found'
  | 'encryption_failed';

export class PublishSourceFailure extends Error {
  override readonly name = 'PublishSourceFailure';

  constructor(
    readonly code: PublishSourceFailureCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
  }
}

/** Bytes available for an inert cover renderer, named from the input, not the editable filename. */
export interface PublishPreviewSource {
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  /** Returns undefined without reading the entry when it exceeds maxBytes. */
  read(maxBytes: number): Promise<Blob | undefined>;
}

export interface PublishFolderEntry {
  readonly path: string;
  readonly size: number;
  readonly mimetype: string;
  readonly rendererClass: RendererClass;
}

export interface PublishFolderOmission {
  readonly path: string;
  readonly reason: 'os_metadata' | 'git_metadata' | 'node_modules' | 'symlink';
}

interface ReviewedSourceBase {
  readonly filename: string;
  readonly rendererClass: RendererClass;
  /** The exact grant size: file bytes, or folder manifest plus entry bytes. */
  readonly plaintextLength: number;
  readonly preview: PublishPreviewSource;
  encrypt(key: Uint8Array): Promise<Uint8Array | Blob>;
}

export interface ReviewedFileSource extends ReviewedSourceBase {
  readonly shape: 'file';
  encrypt(key: Uint8Array): Promise<Uint8Array>;
}

export interface ReviewedFolderSource extends ReviewedSourceBase {
  readonly shape: 'folder';
  readonly rendererClass: 'folder';
  readonly entries: readonly PublishFolderEntry[];
  readonly defaultEntry: string;
  readonly omissions: readonly PublishFolderOmission[];
  encrypt(key: Uint8Array): Promise<Blob>;
  withSelection(filename: string, openFirst?: string): ReviewedFolderSource;
}

export type ReviewedPublishSource = ReviewedFileSource | ReviewedFolderSource;

export interface PreparePublishSourceOptions {
  /** Defaults on for a selected .zip, regardless of the editable filename. */
  readonly expand?: boolean;
  /** Undefined uses the source name. An explicit empty string stays empty. */
  readonly filename?: string;
  /** Undefined selects automatically; a missing or invalid path is refused. */
  readonly openFirst?: string;
}

export function canExpandZip(file: Pick<File, 'name'>): boolean {
  return /\.zip$/i.test(file.name);
}

function requireBoundedSize(size: number): void {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > BROWSER_PUBLISH_LIMIT_BYTES
  ) {
    throw new PublishSourceFailure(
      'size_over_cap',
      'This source exceeds the browser publishing size limit.',
      {
        declared_size_bytes: size,
        size_limit_bytes: BROWSER_PUBLISH_LIMIT_BYTES,
      }
    );
  }
}

function checkFilename(filename: string): void {
  const bytes = encoder.encode(filename).length;
  if (bytes > MAX_FILENAME_BYTES) {
    throw new PublishSourceFailure(
      'filename_too_long',
      `The filename is ${bytes} UTF-8 bytes; the limit is ${MAX_FILENAME_BYTES}.`,
      { filename_bytes: bytes, limit: MAX_FILENAME_BYTES }
    );
  }
}

function checkPreviewLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      'Preview size limit must be a nonnegative safe integer'
    );
  }
}

function zipFailure(refusal: ZipRefusal): PublishSourceFailure {
  return new PublishSourceFailure(
    'zip_invalid',
    `${refusal.message}. Choose the original ZIP as one file instead.`,
    { reason: refusal.reason }
  );
}

async function readZipEntry(
  index: ZipIndex,
  name: string
): Promise<Uint8Array> {
  const result = await index.read(name);
  if (!result.ok) throw zipFailure(result);
  return result.bytes;
}

interface IndexedFile {
  readonly path: string;
  readonly sourcePath: string;
  readonly size: number;
}

/**
 * Review a source locally. No network request, grant, or upload is performed.
 * Expansion checks and reads every included entry before a source is returned.
 */
export async function preparePublishSource(
  file: File,
  options: PreparePublishSourceOptions = {}
): Promise<ReviewedPublishSource> {
  requireBoundedSize(file.size);
  const eligible = canExpandZip(file);
  const expand = options.expand ?? eligible;
  if (expand && !eligible) {
    throw new PublishSourceFailure(
      'zip_not_supported',
      'Only a selected ZIP file can be expanded into a folder.'
    );
  }
  if (!expand && options.openFirst !== undefined) {
    throw new PublishSourceFailure(
      'open_first_not_found',
      'A default entry can only be chosen for an expanded ZIP.'
    );
  }
  const filename =
    options.filename ?? (expand ? file.name.replace(/\.zip$/i, '') : file.name);
  checkFilename(filename);
  if (expand) return prepareFolder(file, filename, options.openFirst);

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    throw new PublishSourceFailure(
      'source_unreadable',
      'This file could not be read. To publish a folder, select a ZIP archive or use the coding agent.'
    );
  }
  if (bytes.length !== file.size) {
    throw new PublishSourceFailure(
      'source_unreadable',
      'The selected file changed while it was read.'
    );
  }
  const rendererClass = deriveRendererClass(bytes, filename);
  const mimetype = guessMimetype(filename, rendererClass);
  const originalClass = deriveRendererClass(bytes, file.name);
  const originalMimetype = guessMimetype(file.name, originalClass);
  return {
    shape: 'file',
    filename,
    rendererClass,
    plaintextLength: bytes.length,
    preview: {
      name: file.name,
      mimetype: originalMimetype,
      size: bytes.length,
      async read(maxBytes) {
        checkPreviewLimit(maxBytes);
        if (bytes.length > maxBytes) return undefined;
        return new Blob([bytes as BlobPart], { type: originalMimetype });
      },
    },
    async encrypt(key) {
      return encryptRelic({ content: bytes, filename, mimetype, key });
    },
  };
}

async function prepareFolder(
  file: File,
  filename: string,
  openFirst: string | undefined
): Promise<ReviewedFolderSource> {
  const result = await indexZip(
    {
      size: file.size,
      async read(start, end) {
        return new Uint8Array(await file.slice(start, end).arrayBuffer());
      },
    },
    {
      maxArchiveBytes: BROWSER_PUBLISH_LIMIT_BYTES,
      maxEntries: MAX_ZIP_ENTRIES,
      maxEntryBytes: BROWSER_PUBLISH_LIMIT_BYTES,
      maxTotalBytes: BROWSER_PUBLISH_LIMIT_BYTES,
    }
  );
  if (!result.ok) throw zipFailure(result);
  const index = result.index;
  const files: IndexedFile[] = [];
  const omissions: PublishFolderOmission[] = [];
  let totalBytes = 0;
  let minimumManifestBytes = 4;
  for (const entry of index.entries.values()) {
    if (entry.kind === 'directory') continue;
    const segments = entry.name.split('/');
    const reason =
      segments.includes('__MACOSX') ||
      segments.some(
        (segment) => segment === '.DS_Store' || segment.startsWith('._')
      )
        ? 'os_metadata'
        : segments.includes('.git')
          ? 'git_metadata'
          : segments.includes('node_modules')
            ? 'node_modules'
            : entry.kind === 'symlink'
              ? 'symlink'
              : undefined;
    if (reason !== undefined) {
      omissions.push({ path: entry.name, reason });
      continue;
    }
    const normalized = normaliseEntryPath(entry.name);
    if (!normalized.ok) {
      throw new PublishSourceFailure(
        'zip_invalid',
        `A ZIP entry has an invalid name (${normalized.rule}). Choose the original ZIP as one file instead.`,
        { name: entry.name, rule: normalized.rule }
      );
    }
    files.push({
      path: normalized.path,
      sourcePath: entry.name,
      size: entry.size,
    });
    totalBytes += entry.size;
    minimumManifestBytes += 12 + encoder.encode(normalized.path).length;
  }
  if (files.length > MAX_ENTRIES) {
    throw new PublishSourceFailure(
      'too_many_files',
      'The ZIP contains too many publishable files.',
      {
        file_count: files.length,
        limit: MAX_ENTRIES,
      }
    );
  }
  if (files.length === 0) {
    throw new PublishSourceFailure(
      'folder_empty',
      'The ZIP contains no publishable files.',
      {
        omissions,
      }
    );
  }
  files.sort((a, b) => compareEntryPaths(a.path, b.path));
  const checked = checkEntrySet(files.map((entry) => entry.path));
  if (!checked.ok) {
    throw new PublishSourceFailure(
      'path_collision',
      'ZIP entry paths collide after normalization.',
      {
        rule: checked.rule,
        paths: checked.paths,
      }
    );
  }
  if (minimumManifestBytes > MAX_MANIFEST_BYTES) {
    throw new PublishSourceFailure(
      'manifest_too_large',
      'The ZIP file list exceeds the manifest limit.',
      {
        limit: MAX_MANIFEST_BYTES,
      }
    );
  }
  requireBoundedSize(totalBytes + minimumManifestBytes);

  const entries: PublishFolderEntry[] = [];
  for (const item of files) {
    // A complete read validates compression, size and CRC before granting; it also
    // matches the MCP's content-based renderer classification and entry choice.
    const bytes = await readZipEntry(index, item.sourcePath);
    const rendererClass = deriveRendererClass(bytes, item.path);
    entries.push({
      path: item.path,
      size: item.size,
      mimetype: guessMimetype(item.path, rendererClass),
      rendererClass,
    });
  }
  const manifestBytes =
    4 +
    entries.reduce(
      (sum, entry) =>
        sum +
        12 +
        encoder.encode(entry.path).length +
        encoder.encode(entry.mimetype).length,
      0
    );
  if (manifestBytes > MAX_MANIFEST_BYTES) {
    throw new PublishSourceFailure(
      'manifest_too_large',
      'The ZIP file list exceeds the manifest limit.',
      {
        file_list_bytes: manifestBytes,
        limit: MAX_MANIFEST_BYTES,
      }
    );
  }
  const plaintextLength = totalBytes + manifestBytes;
  requireBoundedSize(plaintextLength);
  const choices = entries.map((entry) => ({
    path: entry.path,
    renderable: isRenderable(entry.rendererClass),
  }));
  const withSelection = (
    name: string,
    selectedPath?: string
  ): ReviewedFolderSource => {
    checkFilename(name);
    const selected = chooseDefaultEntry(choices, selectedPath);
    if (!selected.ok) {
      throw new PublishSourceFailure(
        'open_first_not_found',
        'The selected default entry is not in this ZIP.',
        { open_first: selectedPath }
      );
    }
    const manifest = encodeManifest(
      selected.index,
      entries.map((entry) => ({
        path: entry.path,
        mimetype: entry.mimetype,
        length: entry.size,
      }))
    );
    const defaultEntry = entries[selected.index]!;
    const selectedFile = files[selected.index]!;

    return {
      shape: 'folder',
      filename: name,
      rendererClass: 'folder',
      plaintextLength,
      entries,
      defaultEntry: defaultEntry.path,
      omissions,
      withSelection,
      preview: {
        name: defaultEntry.path,
        mimetype: defaultEntry.mimetype,
        size: defaultEntry.size,
        async read(maxBytes) {
          checkPreviewLimit(maxBytes);
          if (defaultEntry.size > maxBytes) return undefined;
          const bytes = await readZipEntry(index, selectedFile.sourcePath);
          return new Blob([bytes as BlobPart], { type: defaultEntry.mimetype });
        },
      },
      async encrypt(key) {
        const sources = entries.map((entry, i) => ({
          path: entry.path,
          mimetype: entry.mimetype,
          bytes: {
            size: entry.size,
            async *chunks() {
              yield await readZipEntry(index, files[i]!.sourcePath);
            },
          },
        }));
        const stream = encryptFolderStream({
          name,
          defaultIndex: selected.index,
          entries: sources,
          originalManifest: manifest,
          key,
        });
        const reader = stream.getReader();
        const expected = encryptedSize(plaintextLength);
        const chunks: BlobPart[] = [];
        let length = 0;
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            length += next.value.length;
            if (length > expected) {
              throw new PublishSourceFailure(
                'encryption_failed',
                'The encrypted folder exceeded its expected size.'
              );
            }
            chunks.push(next.value as BlobPart);
          }
          if (length !== expected) {
            throw new PublishSourceFailure(
              'encryption_failed',
              'The encrypted folder has an unexpected size.'
            );
          }
          return new Blob(chunks, { type: 'application/octet-stream' });
        } catch (error) {
          await reader.cancel().catch(() => undefined);
          throw error;
        } finally {
          reader.releaseLock();
        }
      },
    };
  };
  return withSelection(filename, openFirst);
}
