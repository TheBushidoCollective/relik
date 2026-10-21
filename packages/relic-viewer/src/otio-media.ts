/**
 * OpenTimelineIO native media resolver for Relik viewer.
 *
 * Enforces bundle-only access:
 * - Pure byte-indexed access via OtioZipIndex.
 * - Strict URL/path validation: rejects remote schemes (http, https, ftp, etc.),
 *   absolute paths, authority escapes, path traversal (..).
 * - Single-pass deliberate percent-decoding.
 * - Bounded decompression tracking with configurable ceiling (default 100 MiB).
 * - Automatic MIME type sniffing and Blob / Object URL lifecycle management.
 * - Resolves ImageSequenceReference frames with padding, stepping, and policy.
 * - Full disposal of all created Object URLs.
 */

import type {
  OtioMediaReference,
  OtioRationalTime,
  OtioZipIndex,
} from '@relic/format';
import { MAX_EXPANDED_ZIP_BYTES, timeToSeconds } from '@relic/format';

export const DEFAULT_MAX_DECOMPRESSED_BYTES = MAX_EXPANDED_ZIP_BYTES; // 100 MiB

export interface OtioMediaResolverOptions {
  /** Maximum cumulative decompressed bytes allowed across this resolver. */
  readonly maxDecompressedBytes?: number;
}

export interface OtioMediaResolver {
  /** Resolve bundle path to a local Blob. Returns null if missing or invalid. */
  resolveBlob(bundlePath: string): Promise<Blob | null>;
  /** Resolve bundle path to an Object URL. Returns null if missing or invalid. */
  resolveUrl(bundlePath: string): Promise<string | null>;
  /** Check if a bundle path exists in the archive index. */
  hasEntry(bundlePath: string): boolean;
  /** Get cumulative decompressed bytes so far. */
  getDecompressedBytes(): number;
  /** Revoke all created Object URLs and clear memory. */
  dispose(): void;
}

/**
 * Infer media MIME type from file extension.
 */
export function inferMediaMimeType(filename: string): string {
  const clean = filename.split('?')[0].split('#')[0];
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

  // Reject ASCII control characters
  for (let i = 0; i < rawPath.length; i++) {
    const code = rawPath.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error(`Bundle media path contains control character at index ${i}`);
    }
  }

  let path = rawPath.trim();

  // Strip query strings or fragments if present in target URLs
  const qIdx = path.indexOf('?');
  if (qIdx !== -1) path = path.slice(0, qIdx);
  const fIdx = path.indexOf('#');
  if (fIdx !== -1) path = path.slice(0, fIdx);

  // Check for schemes
  const schemeMatch = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.exec(path);
  if (schemeMatch) {
    const scheme = schemeMatch[0].toLowerCase();
    if (scheme === 'file:') {
      // Allow relative file: paths, but reject absolute or authority file://
      const after = path.slice(5);
      if (after.startsWith('//') || after.startsWith('/') || after.startsWith('\\')) {
        throw new Error(`Forbidden absolute or remote file URI: ${rawPath}`);
      }
      path = after;
    } else {
      throw new Error(`Forbidden remote media URL scheme: ${scheme} in ${rawPath}`);
    }
  }

  // Single-pass deliberate percent-decoding
  try {
    path = decodeURIComponent(path);
  } catch {
    throw new Error(`Malformed percent-encoding in bundle path: ${rawPath}`);
  }

  // Check again after decoding for control characters
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 32 || code === 127) {
      throw new Error(`Bundle media path contains control character after decoding: ${rawPath}`);
    }
  }

  // Reject Windows drive letters
  if (/^[a-zA-Z]:[/\\]/.test(path)) {
    throw new Error(`Forbidden absolute Windows drive path: ${rawPath}`);
  }

  // Reject leading slashes
  if (path.startsWith('/') || path.startsWith('\\')) {
    throw new Error(`Forbidden absolute path: ${rawPath}`);
  }

  // Normalize path segments and reject traversal above root
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
 * Resolve an ImageSequenceReference into the bundle path for a specific source time.
 */
export function resolveImageSequenceFramePath(
  ref: OtioMediaReference,
  sourceTime: OtioRationalTime
): string | null {
  if (
    ref.schema !== 'ImageSequenceReference' &&
    !ref.schema.startsWith('ImageSequenceReference')
  ) {
    return null;
  }

  const rate = ref.rate && ref.rate > 0 ? ref.rate : sourceTime.rate;
  const startFrame = ref.start_frame ?? 0;
  const frameStep = ref.frame_step ?? 1;
  const padding = ref.frame_zero_padding ?? 0;

  const seconds = timeToSeconds(sourceTime);
  const frameIndex = Math.floor(seconds * rate);
  const frameNumber = startFrame + frameIndex * frameStep;

  let paddedStr: string;
  if (frameNumber < 0) {
    paddedStr = String(frameNumber);
  } else if (padding > 0) {
    paddedStr = String(frameNumber).padStart(padding, '0');
  } else {
    paddedStr = String(frameNumber);
  }

  const base = ref.target_url_base ?? '';
  const prefix = ref.name_prefix ?? '';
  const suffix = ref.name_suffix ?? '';
  const rawCombined = `${base}${prefix}${paddedStr}${suffix}`;

  try {
    return sanitizeBundlePath(rawCombined);
  } catch {
    return null;
  }
}

/**
 * Create a native bundle media resolver backed by an OtioZipIndex.
 */
export function createOtioMediaResolver(
  zipIndex: OtioZipIndex,
  options: OtioMediaResolverOptions = {}
): OtioMediaResolver {
  const maxDecompressedBytes =
    options.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;

  let totalDecompressedBytes = 0;
  let disposed = false;

  const blobCache = new Map<string, Blob>();
  const urlCache = new Map<string, string>();
  const allocatedUrls = new Set<string>();

  function findZipEntryName(normalizedPath: string): string | null {
    if (zipIndex.entries.has(normalizedPath)) {
      return normalizedPath;
    }
    // Also try media/ prefix if omitted
    if (!normalizedPath.startsWith('media/')) {
      const withMedia = `media/${normalizedPath}`;
      if (zipIndex.entries.has(withMedia)) {
        return withMedia;
      }
    }
    // Also try stripping media/ prefix if present
    if (normalizedPath.startsWith('media/')) {
      const stripped = normalizedPath.slice(6);
      if (zipIndex.entries.has(stripped)) {
        return stripped;
      }
    }
    return null;
  }

  return {
    hasEntry(bundlePath: string): boolean {
      if (disposed) return false;
      try {
        const normalized = sanitizeBundlePath(bundlePath);
        return findZipEntryName(normalized) !== null;
      } catch {
        return false;
      }
    },

    getDecompressedBytes(): number {
      return totalDecompressedBytes;
    },

    async resolveBlob(bundlePath: string): Promise<Blob | null> {
      if (disposed) return null;

      let normalized: string;
      try {
        normalized = sanitizeBundlePath(bundlePath);
      } catch {
        return null;
      }

      const cachedBlob = blobCache.get(normalized);
      if (cachedBlob) {
        return cachedBlob;
      }

      const entryName = findZipEntryName(normalized);
      if (!entryName) {
        return null;
      }

      const entry = zipIndex.entries.get(entryName);
      if (!entry) {
        return null;
      }

      // Check uncompressed size bound
      if (totalDecompressedBytes + entry.uncompressedSize > maxDecompressedBytes) {
        throw new Error(
          `Decompression limit exceeded: ${entryName} (${entry.uncompressedSize} bytes) ` +
            `would exceed aggregate cap of ${maxDecompressedBytes} bytes (already decompressed ${totalDecompressedBytes})`
        );
      }

      const bytes = await zipIndex.readEntry(entryName);
      if (disposed) return null;

      totalDecompressedBytes += bytes.byteLength;
      if (totalDecompressedBytes > maxDecompressedBytes) {
        throw new Error(
          `Decompression limit exceeded: aggregate decompressed bytes ${totalDecompressedBytes} exceeds limit ${maxDecompressedBytes}`
        );
      }

      const mimeType = inferMediaMimeType(entryName);
      const blob = new Blob([bytes], { type: mimeType });
      blobCache.set(normalized, blob);
      return blob;
    },

    async resolveUrl(bundlePath: string): Promise<string | null> {
      if (disposed) return null;

      let normalized: string;
      try {
        normalized = sanitizeBundlePath(bundlePath);
      } catch {
        return null;
      }

      const cachedUrl = urlCache.get(normalized);
      if (cachedUrl) {
        return cachedUrl;
      }

      const blob = await this.resolveBlob(bundlePath);
      if (!blob || disposed) {
        return null;
      }

      // In browser/Node environments with URL.createObjectURL
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        const url = URL.createObjectURL(blob);
        urlCache.set(normalized, url);
        allocatedUrls.add(url);
        return url;
      }

      return null;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;

      if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
        for (const url of allocatedUrls) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // Ignore revoke errors
          }
        }
      }

      allocatedUrls.clear();
      urlCache.clear();
      blobCache.clear();
    },
  };
}
