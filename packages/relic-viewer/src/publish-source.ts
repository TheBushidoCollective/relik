import {
  deriveRendererClass,
  encryptRelic,
  guessMimetype,
} from '@relic/format';
import {
  abortable,
  checkFilename,
  checkPreviewLimit,
  PublishSourceFailure,
  requireBoundedSize,
  rethrowAbort,
  throwIfAborted,
  type ReviewedPublishSource,
} from './browser-folder-preflight.ts';
import { prepareBrowserZip } from './browser-zip-source.ts';

export {
  BROWSER_PUBLISH_LIMIT_BYTES,
  PublishSourceFailure,
} from './browser-folder-preflight.ts';
export type {
  PublishFolderEntry,
  PublishFolderOmission,
  PublishPreviewSource,
  PublishSourceFailureCode,
  ReviewedFileSource,
  ReviewedFolderSource,
  ReviewedPublishSource,
} from './browser-folder-preflight.ts';

export interface PreparePublishSourceOptions {
  /** Defaults on for a selected .zip, regardless of the editable filename. */
  readonly expand?: boolean;
  /** Undefined uses the source name. An explicit empty string stays empty. */
  readonly filename?: string;
  /** Undefined selects automatically; a missing or invalid path is refused. */
  readonly openFirst?: string;
  /** Cancel local source review before it completes. */
  readonly signal?: AbortSignal;
}

export function canExpandZip(file: Pick<File, 'name'>): boolean {
  return /\.zip$/i.test(file.name);
}

/**
 * Review a source locally. No network request, grant, or upload is performed.
 * Expansion checks and reads every included entry before a source is returned.
 */
export async function preparePublishSource(
  file: File,
  options: PreparePublishSourceOptions = {}
): Promise<ReviewedPublishSource> {
  throwIfAborted(options.signal);
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
  if (expand) {
    return prepareBrowserZip(file, {
      filename,
      ...(options.openFirst === undefined
        ? {}
        : { openFirst: options.openFirst }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  let bytes: Uint8Array;
  try {
    throwIfAborted(options.signal);
    bytes = new Uint8Array(await abortable(file.arrayBuffer(), options.signal));
    throwIfAborted(options.signal);
  } catch (error) {
    rethrowAbort(error, options.signal);
    throw new PublishSourceFailure(
      'source_unreadable',
      'This file could not be read. Check that it is available on this device.'
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
