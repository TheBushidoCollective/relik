/**
 * OpenTimelineIO native media resolver for Relik viewer.
 *
 * Bundle-only access: validated ZIP entries, no remote URLs, no sequence
 * renumbering. The evaluator owns image-sequence paths. This module reserves
 * archive bytes before inflation, shares one in-flight read per canonical
 * entry, and remembers permanent read failures so playback cannot retry a
 * bad entry every frame.
 */

import {
  MAX_EXPANDED_ZIP_BYTES,
  type OtioBundleEntryName,
  type OtioZipEntryInfo,
  type OtioZipIndex,
} from '@relic/format';

export const DEFAULT_MAX_DECOMPRESSED_BYTES = MAX_EXPANDED_ZIP_BYTES;

export interface OtioMediaResolverOptions {
  /** Maximum cumulative decompressed bytes allowed across this resolver. */
  readonly maxDecompressedBytes?: number;
}

/**
 * Blob parts cannot take a SharedArrayBuffer-backed view. Keep normal ZIP
 * entries as views of their original ArrayBuffer, and copy only shared bytes.
 */
function blobBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = bytes.buffer;
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength);
  }
  return Uint8Array.from(bytes);
}

export interface OtioMediaResolver {
  /** Resolve a canonical bundle entry name to a local Blob. */
  resolveBlob(entryName: OtioBundleEntryName): Promise<Blob | null>;
  /** Resolve a canonical bundle entry name to an Object URL. */
  resolveUrl(entryName: OtioBundleEntryName): Promise<string | null>;
  /** Check whether a canonical bundle entry name exists in the archive index. */
  hasEntry(entryName: OtioBundleEntryName): boolean;
  /** Get cumulative decompressed bytes charged so far. */
  getDecompressedBytes(): number;
  /** Revoke all created Object URLs and clear memory. */
  dispose(): void;
}

/**
 * Infer media MIME type from file extension.
 */
export function inferMediaMimeType(filename: string): string {
  const segment = filename.slice(filename.lastIndexOf('/') + 1);
  const dot = segment.lastIndexOf('.');
  const ext = dot === -1 ? '' : segment.slice(dot + 1).toLowerCase();
  switch (ext) {
    case 'mp4':
    case 'm4v':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'mov':
      return 'video/quicktime';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'aac':
      return 'audio/aac';
    case 'ogg':
    case 'oga':
      return 'audio/ogg';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'gif':
      return 'image/gif';
    case 'svg':
      return 'image/svg+xml';
    case 'exr':
      return 'image/x-exr';
    case 'dpx':
      return 'image/x-dpx';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Create a native bundle media resolver backed by an OtioZipIndex.
 *
 * The caller owns this object. Playback must not dispose a resolver it was
 * given; the view disposes it on unmount so a timeline switch can reuse it.
 */
export function createOtioMediaResolver(
  zipIndex: OtioZipIndex,
  options: OtioMediaResolverOptions = {}
): OtioMediaResolver {
  const maxDecompressedBytes =
    options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;

  let chargedBytes = 0;
  let disposed = false;

  const blobByEntry = new Map<OtioBundleEntryName, Blob>();
  const urlByEntry = new Map<OtioBundleEntryName, string>();
  const blobInflight = new Map<OtioBundleEntryName, Promise<Blob>>();
  const urlInflight = new Map<OtioBundleEntryName, Promise<string | null>>();
  const failures = new Map<OtioBundleEntryName, Error>();
  const allocatedUrls = new Set<string>();

  function exactMediaEntry(
    entryName: OtioBundleEntryName
  ): OtioZipEntryInfo | null {
    if (!entryName.startsWith('media/')) return null;
    const entry = zipIndex.entries.get(entryName);
    return entry && !entry.isDirectory ? entry : null;
  }

  function limitError(entryName: OtioBundleEntryName, size: number): Error {
    return new Error(
      `Decompression limit exceeded: ${entryName} (${size} bytes) ` +
        `would exceed aggregate cap of ${maxDecompressedBytes} bytes ` +
        `(already decompressed ${chargedBytes})`
    );
  }

  function loadEntry(entryName: OtioBundleEntryName): Promise<Blob> {
    const cached = blobByEntry.get(entryName);
    if (cached) return Promise.resolve(cached);
    const pending = blobInflight.get(entryName);
    if (pending) return pending;
    const prior = failures.get(entryName);
    if (prior) return Promise.reject(prior);

    const entry = exactMediaEntry(entryName);
    if (!entry) {
      return Promise.reject(new Error(`Entry not found: ${entryName}`));
    }
    const declared = entry.uncompressedSize;
    if (
      !Number.isFinite(declared) ||
      declared < 0 ||
      chargedBytes + declared > maxDecompressedBytes
    ) {
      const err = limitError(entryName, declared);
      failures.set(entryName, err);
      return Promise.reject(err);
    }

    chargedBytes += declared;
    let adjusted = false;
    const promise = (async () => {
      try {
        const bytes = await zipIndex.readEntry(entryName);
        if (disposed) {
          throw new Error('resolver disposed');
        }
        const actual = bytes.byteLength;
        chargedBytes += actual - declared;
        adjusted = true;
        if (chargedBytes > maxDecompressedBytes) {
          const err = new Error(
            `Decompression limit exceeded: aggregate decompressed bytes ` +
              `${chargedBytes} exceeds limit ${maxDecompressedBytes}`
          );
          chargedBytes -= actual;
          failures.set(entryName, err);
          throw err;
        }
        const blob = new Blob([blobBytes(bytes)], {
          type: inferMediaMimeType(entryName),
        });
        blobByEntry.set(entryName, blob);
        return blob;
      } catch (error) {
        if (!adjusted) chargedBytes -= declared;
        const err = error instanceof Error ? error : new Error(String(error));
        if (err.message !== 'resolver disposed') {
          failures.set(entryName, err);
        }
        throw err;
      } finally {
        blobInflight.delete(entryName);
      }
    })();
    blobInflight.set(entryName, promise);
    return promise;
  }

  function createUrl(entryName: OtioBundleEntryName): Promise<string | null> {
    return loadEntry(entryName)
      .then((blob) => {
        if (disposed) return null;
        const existing = urlByEntry.get(entryName);
        if (existing) return existing;
        if (
          typeof URL === 'undefined' ||
          typeof URL.createObjectURL !== 'function'
        ) {
          return null;
        }
        const url = URL.createObjectURL(blob);
        urlByEntry.set(entryName, url);
        allocatedUrls.add(url);
        return url;
      })
      .catch(() => null)
      .finally(() => {
        urlInflight.delete(entryName);
      });
  }

  return {
    hasEntry(entryName: OtioBundleEntryName): boolean {
      return !disposed && exactMediaEntry(entryName) !== null;
    },

    getDecompressedBytes(): number {
      return chargedBytes;
    },

    resolveBlob(entryName: OtioBundleEntryName): Promise<Blob | null> {
      if (disposed || !exactMediaEntry(entryName)) {
        return Promise.resolve(null);
      }
      return loadEntry(entryName);
    },

    resolveUrl(entryName: OtioBundleEntryName): Promise<string | null> {
      if (disposed || !exactMediaEntry(entryName)) {
        return Promise.resolve(null);
      }
      const cached = urlByEntry.get(entryName);
      if (cached) return Promise.resolve(cached);
      const pending = urlInflight.get(entryName);
      if (pending) return pending;
      const promise = createUrl(entryName);
      urlInflight.set(entryName, promise);
      return promise;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (
        typeof URL !== 'undefined' &&
        typeof URL.revokeObjectURL === 'function'
      ) {
        for (const url of allocatedUrls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Ignore revoke errors.
          }
        }
      }
      urlByEntry.clear();
      blobByEntry.clear();
      failures.clear();
    },
  };
}
