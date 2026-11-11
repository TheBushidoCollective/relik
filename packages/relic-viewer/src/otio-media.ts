/**
 * OpenTimelineIO native media resolver for Relik viewer.
 *
 * Bundle-only access: validated ZIP entries, no remote URLs, no sequence
 * renumbering. Stored entries remain slices of the original bundle; only
 * deflated entries consume the cumulative inflation budget. Reads and
 * failures are shared so playback cannot repeatedly process a bad entry.
 */

import {
  Crc32,
  MAX_INFLATED_ZIP_BYTES,
  type OtioBundleEntryName,
  type OtioZipEntryInfo,
  type OtioZipIndex,
} from '@relic/format';

export const DEFAULT_MAX_INFLATED_BYTES = MAX_INFLATED_ZIP_BYTES;
const BLOB_BATCH_BYTES = 8 * 1024 * 1024;

export interface OtioMediaResolverOptions {
  /** Maximum cumulative DEFLATE output retained by this resolver. */
  readonly maxInflatedBytes?: number;
}

/**
 * Blob parts cannot take a SharedArrayBuffer-backed view. Keep normal
 * decompressor output as views, and copy only shared bytes.
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
  /** Get cumulative DEFLATE output bytes charged so far. */
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
  bundle: Blob,
  options: OtioMediaResolverOptions = {}
): OtioMediaResolver {
  const maxInflatedBytes =
    options.maxInflatedBytes ?? DEFAULT_MAX_INFLATED_BYTES;
  if (!Number.isSafeInteger(maxInflatedBytes) || maxInflatedBytes < 0) {
    throw new RangeError('Invalid OTIO media inflation limit');
  }

  let chargedBytes = 0;
  let disposed = false;
  const abort = new AbortController();

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
        `would exceed aggregate cap of ${maxInflatedBytes} bytes ` +
        `(already decompressed ${chargedBytes})`
    );
  }

  async function inflateEntry(entry: OtioZipEntryInfo): Promise<Blob> {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('No DecompressionStream available for OTIO media');
    }
    const reader = bundle
      .slice(entry.dataOffset, entry.dataOffset + entry.compressedSize)
      .stream()
      .pipeThrough(new DecompressionStream('deflate-raw'), {
        signal: abort.signal,
      })
      .getReader();
    const checksum = new Crc32();
    const parts: Blob[] = [];
    let batch: Uint8Array<ArrayBuffer>[] = [];
    let batchBytes = 0;
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (disposed) throw new Error('resolver disposed');
        if (!value || value.byteLength === 0) continue;
        if (value.byteLength > entry.uncompressedSize - total) {
          throw new Error(
            `Inflated media exceeds declared size: ${entry.name}`
          );
        }
        total += value.byteLength;
        checksum.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const length = Math.min(
            BLOB_BATCH_BYTES - batchBytes,
            value.byteLength - offset
          );
          batch.push(blobBytes(value.subarray(offset, offset + length)));
          batchBytes += length;
          offset += length;
          if (batchBytes === BLOB_BATCH_BYTES) {
            parts.push(new Blob(batch));
            batch = [];
            batchBytes = 0;
          }
        }
      }
      if (total !== entry.uncompressedSize) {
        throw new Error(`Inflated media has the wrong size: ${entry.name}`);
      }
      if (checksum.value() !== entry.crc32) {
        throw new Error(`CRC32 mismatch: ${entry.name}`);
      }
      if (batchBytes) parts.push(new Blob(batch));
      return new Blob(parts, { type: inferMediaMimeType(entry.name) });
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the inflation, size, or checksum failure.
      }
      throw error;
    } finally {
      reader.releaseLock();
    }
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
      !Number.isSafeInteger(entry.dataOffset) ||
      !Number.isSafeInteger(entry.compressedSize) ||
      !Number.isSafeInteger(declared) ||
      entry.dataOffset < 0 ||
      entry.compressedSize < 0 ||
      declared < 0 ||
      entry.dataOffset > bundle.size - entry.compressedSize ||
      (entry.method !== 0 && entry.method !== 8) ||
      (entry.method === 0 && entry.compressedSize !== declared)
    ) {
      const err = new Error(`Invalid media entry bounds: ${entryName}`);
      failures.set(entryName, err);
      return Promise.reject(err);
    }
    const charge = entry.method === 8 ? declared : 0;
    if (charge > maxInflatedBytes - chargedBytes) {
      const err = limitError(entryName, declared);
      failures.set(entryName, err);
      return Promise.reject(err);
    }

    chargedBytes += charge;
    const promise = (async () => {
      try {
        let blob: Blob;
        if (entry.method === 0) {
          await zipIndex.verifyStoredEntry(entryName);
          blob = bundle.slice(
            entry.dataOffset,
            entry.dataOffset + declared,
            inferMediaMimeType(entryName)
          );
        } else {
          blob = await inflateEntry(entry);
        }
        if (disposed) throw new Error('resolver disposed');
        blobByEntry.set(entryName, blob);
        return blob;
      } catch (error) {
        chargedBytes -= charge;
        const err = error instanceof Error ? error : new Error(String(error));
        if (!disposed) failures.set(entryName, err);
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
      abort.abort();
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
