import {
  checkEntrySet,
  chooseDefaultEntry,
  compareEntryPaths,
  deriveRendererClass,
  encodeManifest,
  encryptFolderStream,
  encryptedSize,
  guessMimetype,
  isRenderable,
  MAX_ENTRIES,
  MAX_FILENAME_BYTES,
  MAX_MANIFEST_BYTES,
  normaliseEntryPath,
  type RendererClass,
} from '@relic/format';

/** The browser caps both the selected input and the plaintext it will publish. */
export const BROWSER_PUBLISH_LIMIT_BYTES = 100_000_000;
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

/** Bytes available for an inert cover renderer, named from the original input. */
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
  readonly reason: string;
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
  readonly source: 'zip' | 'directory';
  readonly rendererClass: 'folder';
  readonly entries: readonly PublishFolderEntry[];
  readonly defaultEntry: string;
  readonly omissions: readonly PublishFolderOmission[];
  encrypt(key: Uint8Array): Promise<Blob>;
  withSelection(filename: string, openFirst?: string): ReviewedFolderSource;
}

export type ReviewedPublishSource = ReviewedFileSource | ReviewedFolderSource;
export type BrowserOmission = PublishFolderOmission;
export type BrowserFolder = ReviewedFolderSource;

export interface BrowserFolderFile {
  readonly path: string;
  readonly size: number;
  read(): Promise<Uint8Array>;
  chunks(): AsyncIterable<Uint8Array>;
}

export function requireBoundedSize(size: number): void {
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

export function checkFilename(filename: string): void {
  const bytes = encoder.encode(filename).length;
  if (bytes > MAX_FILENAME_BYTES) {
    throw new PublishSourceFailure(
      'filename_too_long',
      `The filename is ${bytes} UTF-8 bytes; the limit is ${MAX_FILENAME_BYTES}.`,
      { filename_bytes: bytes, limit: MAX_FILENAME_BYTES }
    );
  }
}

export function checkPreviewLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      'Preview size limit must be a nonnegative safe integer'
    );
  }
}

/** Normalize, classify and validate either input adapter before any upload. */
export async function prepareBrowserFolder(
  name: string,
  source: 'zip' | 'directory',
  files: BrowserFolderFile[],
  leftOut: BrowserOmission[],
  openFirst?: string
): Promise<ReviewedFolderSource> {
  const fix = source === 'zip' ? ' Publish as one file instead.' : '';
  checkFilename(name);
  const normalized = files.map((file) => {
    const result = normaliseEntryPath(file.path);
    if (!result.ok) {
      throw new PublishSourceFailure(
        source === 'zip' ? 'zip_invalid' : 'source_unreadable',
        `Invalid file path ${file.path}: ${result.rule.replaceAll('_', ' ')} (${result.rule}).${fix}`,
        { name: file.path, rule: result.rule }
      );
    }
    requireBoundedSize(file.size);
    return { ...file, path: result.path };
  });
  normalized.sort((a, b) => compareEntryPaths(a.path, b.path));
  if (normalized.length > MAX_ENTRIES) {
    throw new PublishSourceFailure(
      'too_many_files',
      `Too many files. The limit is ${MAX_ENTRIES}.${fix}`,
      { file_count: normalized.length, limit: MAX_ENTRIES }
    );
  }
  if (!normalized.length) {
    throw new PublishSourceFailure(
      'folder_empty',
      `${leftOut.length ? 'All files were excluded' : 'The folder is empty'}.${fix}`,
      { omissions: leftOut }
    );
  }
  const checked = checkEntrySet(normalized.map((file) => file.path));
  if (!checked.ok) {
    throw new PublishSourceFailure(
      'path_collision',
      `File paths collide (${checked.rule}): ${checked.paths.join(', ')}.${fix}`,
      { rule: checked.rule, paths: checked.paths }
    );
  }
  const totalBytes = normalized.reduce((sum, file) => sum + file.size, 0);
  const minimumManifestBytes =
    4 +
    normalized.reduce(
      (sum, file) => sum + 12 + encoder.encode(file.path).length,
      0
    );
  if (minimumManifestBytes > MAX_MANIFEST_BYTES) {
    throw new PublishSourceFailure(
      'manifest_too_large',
      `The file list exceeds the manifest limit.${fix}`,
      { limit: MAX_MANIFEST_BYTES }
    );
  }
  requireBoundedSize(totalBytes + minimumManifestBytes);

  const entries: PublishFolderEntry[] = [];
  for (const file of normalized) {
    let bytes: Uint8Array;
    try {
      bytes = await file.read();
    } catch (error) {
      if (error instanceof PublishSourceFailure) throw error;
      throw new PublishSourceFailure(
        'source_unreadable',
        `Could not read ${file.path}: ${error instanceof Error ? error.message : 'file unavailable'}.${fix}`
      );
    }
    if (!(bytes instanceof Uint8Array) || bytes.length !== file.size) {
      throw new PublishSourceFailure(
        'source_unreadable',
        `The selected file ${file.path} changed while it was read.${fix}`
      );
    }
    const basename = file.path.split('/').pop() ?? file.path;
    const rendererClass = deriveRendererClass(bytes, basename);
    entries.push({
      path: file.path,
      size: file.size,
      mimetype: guessMimetype(basename, rendererClass),
      rendererClass,
    });
  }
  const choices = entries.map((entry) => ({
    path: entry.path,
    renderable: isRenderable(entry.rendererClass),
  }));
  const sources = entries.map((entry, index) => ({
    path: entry.path,
    mimetype: entry.mimetype,
    bytes: {
      size: entry.size,
      chunks: () => normalized[index]!.chunks(),
    },
  }));

  const withSelection = (
    filename: string,
    openFirst?: string
  ): ReviewedFolderSource => {
    checkFilename(filename);
    const selected = chooseDefaultEntry(choices, openFirst);
    if (!selected.ok) {
      throw new PublishSourceFailure(
        'open_first_not_found',
        `The selected default entry is not in this ${source === 'zip' ? 'ZIP' : 'folder'}.`,
        { open_first: openFirst }
      );
    }
    let manifest: Uint8Array;
    try {
      manifest = encodeManifest(
        selected.index,
        entries.map((entry) => ({
          path: entry.path,
          mimetype: entry.mimetype,
          length: entry.size,
        }))
      );
    } catch (error) {
      throw new PublishSourceFailure(
        'manifest_too_large',
        `Cannot publish the file list: ${error instanceof Error ? error.message : 'invalid folder'}.${fix}`,
        { limit: MAX_MANIFEST_BYTES }
      );
    }
    const plaintextLength = totalBytes + manifest.length;
    requireBoundedSize(plaintextLength);
    const defaultEntry = entries[selected.index]!;
    const selectedFile = normalized[selected.index]!;
    return {
      shape: 'folder',
      source,
      filename,
      rendererClass: 'folder',
      plaintextLength,
      entries,
      defaultEntry: defaultEntry.path,
      omissions: leftOut,
      withSelection,
      preview: {
        name: defaultEntry.path,
        mimetype: defaultEntry.mimetype,
        size: defaultEntry.size,
        async read(maxBytes) {
          checkPreviewLimit(maxBytes);
          if (defaultEntry.size > maxBytes) return undefined;
          const bytes = await selectedFile.read();
          if (bytes.length !== defaultEntry.size) {
            throw new PublishSourceFailure(
              'source_unreadable',
              `The selected file ${defaultEntry.path} changed while it was read.${fix}`
            );
          }
          return new Blob([bytes as BlobPart], { type: defaultEntry.mimetype });
        },
      },
      async encrypt(key) {
        const reader = encryptFolderStream({
          name: filename,
          defaultIndex: selected.index,
          entries: sources,
          originalManifest: manifest,
          key,
        }).getReader();
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
  return withSelection(name, openFirst);
}
