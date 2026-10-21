/**
 * OpenTimelineIO native media resolver for Relik viewer.
 *
 * Bundle-only access: validated ZIP entries, no remote URLs, no sequence
 * renumbering. The evaluator owns image-sequence paths. This module reserves
 * archive bytes before inflation, shares one in-flight read per canonical
 * entry, and remembers permanent read failures so playback cannot retry a
 * bad entry every frame.
 */

import type { OtioZipEntryInfo, OtioZipIndex } from '@relic/format';
import { MAX_EXPANDED_ZIP_BYTES } from '@relic/format';

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
  /** Resolve bundle path to a local Blob. Returns null if missing or invalid. */
  resolveBlob(bundlePath: string): Promise<Blob | null>;
  /** Resolve bundle path to an Object URL. Returns null if missing or invalid. */
  resolveUrl(bundlePath: string): Promise<string | null>;
  /** Check if a bundle path exists in the archive index. */
  hasEntry(bundlePath: string): boolean;
  /** Get cumulative decompressed bytes charged so far. */
  getDecompressedBytes(): number;
  /** Revoke all created Object URLs and clear memory. */
  dispose(): void;
}

/**
 * Infer media MIME type from file extension.
 */
export function inferMediaMimeType(filename: string): string {
  const clean = filename.split('?')[0]?.split('#')[0] ?? filename;
  const ext = clean.split('.').pop()?.toLowerCase();
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
 * Validate and normalize a bundle-relative media path.
 *
 * Rules:
 * 1. Must not be empty.
 * 2. Must not contain control characters or NUL bytes.
 * 3. Must not specify an external scheme (http, https, blob, data, etc.).
 * 4. Tolerates relative `file:` prefix by stripping it.
 * 5. Rejects absolute paths (/ or \ or C:).
 * 6. Single-pass percent-decoding.
 * 7. Rejects path traversal escapes (.. above root).
 */
export function sanitizeBundlePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new Error('Bundle media path must be a non-empty string');
  }

  for (let i = 0; i < rawPath.length; i++) {
    const code = rawPath.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error(
        `Bundle media path contains control character at index ${i}`
      );
    }
  }

  let path = rawPath.trim();

  const qIdx = path.indexOf('?');
  if (qIdx !== -1) path = path.slice(0, qIdx);
  const fIdx = path.indexOf('#');
  if (fIdx !== -1) path = path.slice(0, fIdx);

  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(path);
  if (schemeMatch) {
    const scheme = schemeMatch[0].toLowerCase();
    if (scheme === 'file:') {
      const after = path.slice(5);
      if (
        after.startsWith('//') ||
        after.startsWith('/') ||
        after.startsWith('\\')
      ) {
        throw new Error(`Forbidden absolute or remote file URI: ${rawPath}`);
      }
      path = after;
    } else {
      throw new Error(
        `Forbidden remote media URL scheme: ${scheme} in ${rawPath}`
      );
    }
  }

  try {
    path = decodeURIComponent(path);
  } catch {
    throw new Error(`Malformed percent-encoding in bundle path: ${rawPath}`);
  }

  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error(
        `Bundle media path contains control character after decoding: ${rawPath}`
      );
    }
  }

  if (/^[a-zA-Z]:[/\\]/.test(path)) {
    throw new Error(`Forbidden absolute Windows drive path: ${rawPath}`);
  }

  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`Forbidden absolute path: ${rawPath}`);
  }

  const rawSegments = path.split(/[/\\]+/);
  const segments: string[] = [];

  for (const seg of rawSegments) {
    if (seg === '' || seg === '.') {
      continue;
    }
    if (seg === '..') {
      if (segments.length === 0) {
        throw new Error(`Path traversal escape in bundle path: ${rawPath}`);
      }
      segments.pop();
    } else {
      segments.push(seg);
    }
  }

  if (segments.length === 0) {
    throw new Error(`Empty normalized bundle path from: ${rawPath}`);
  }

  return segments.join('/');
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

  const blobByEntry = new Map<string, Blob>();
  const urlByEntry = new Map<string, string>();
  const blobInflight = new Map<string, Promise<Blob>>();
  const urlInflight = new Map<string, Promise<string | null>>();
  const failures = new Map<string, Error>();
  const allocatedUrls = new Set<string>();

  function findZipEntryName(normalizedPath: string): string | null {
    if (zipIndex.entries.has(normalizedPath)) {
      return normalizedPath;
    }
    if (!normalizedPath.startsWith('media/')) {
      const withMedia = `media/${normalizedPath}`;
      if (zipIndex.entries.has(withMedia)) {
        return withMedia;
      }
    }
    if (normalizedPath.startsWith('media/')) {
      const stripped = normalizedPath.slice('media/'.length);
      if (zipIndex.entries.has(stripped)) {
        return stripped;
      }
    }
    return null;
  }

  function canonicalName(bundlePath: string): string | null {
    try {
      return findZipEntryName(sanitizeBundlePath(bundlePath));
    } catch {
      return null;
    }
  }

  function limitError(entryName: string, size: number): Error {
    return new Error(
      `Decompression limit exceeded: ${entryName} (${size} bytes) ` +
        `would exceed aggregate cap of ${maxDecompressedBytes} bytes ` +
        `(already decompressed ${chargedBytes})`
    );
  }

  function loadEntry(entryName: string): Promise<Blob> {
    const cached = blobByEntry.get(entryName);
    if (cached) return Promise.resolve(cached);
    const pending = blobInflight.get(entryName);
    if (pending) return pending;
    const prior = failures.get(entryName);
    if (prior) return Promise.reject(prior);

    const entry: OtioZipEntryInfo | undefined = zipIndex.entries.get(entryName);
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
        const err =
          error instanceof Error ? error : new Error(String(error));
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

  function createUrl(entryName: string): Promise<string | null> {
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
    hasEntry(bundlePath: string): boolean {
      if (disposed) return false;
      return canonicalName(bundlePath) !== null;
    },

    getDecompressedBytes(): number {
      return chargedBytes;
    },

    resolveBlob(bundlePath: string): Promise<Blob | null> {
      if (disposed) return Promise.resolve(null);
      const entryName = canonicalName(bundlePath);
      if (!entryName) return Promise.resolve(null);
      return loadEntry(entryName);
    },

    resolveUrl(bundlePath: string): Promise<string | null> {
      if (disposed) return Promise.resolve(null);
      const entryName = canonicalName(bundlePath);
      if (!entryName) return Promise.resolve(null);
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
