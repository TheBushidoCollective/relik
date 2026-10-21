/**
 * Anchor resolution against decrypted relic content.
 *
 * An agent reading comments back needs more than a text description of
 * what a human marked. When a reviewer circles a defect on an image or
 * points at a phrase in a document, an agent that receives only the words
 * "a box in the upper left" or a detached quote has to guess where to look
 * and what to change.
 *
 * This module resolves comment anchors against the actual artifact bytes
 * by fetching the ciphertext once, decrypting it using the stored content
 * key, and extracting the pointed-at content:
 * - Quotes and text anchors: exact matching run with surrounding source context.
 * - Regions on images: a cropped view of the region and an annotated full view.
 * - Time moments and spans on video: extracted frame images at the timecode(s).
 * - Time moments on audio: timecode text notice that no frames exist.
 * - Pages on PDF: page number and quoted text, with a notice that server-side
 *   PDF rendering is omitted to avoid heavy client dependencies.
 * - Stage-relative pins: an honest notice that stage-relative pins cannot be
 *   resolved against artifact content with fidelity.
 * - Unsupported anchors: the declared kind preserved without dropping.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRaw } from 'node:zlib';
import {
  type AnchorRect,
  decodeKey,
  deriveRendererClass,
  FORMAT_VERSION,
  type InflaterFn,
  indexOtioZip,
  isOtioz,
  isRawOtio,
  type OpenedRelic,
  type OtioAnchorResolution,
  type OtioAnchorV1,
  otioBundleMediaIndex,
  type OtioMediaEntry,
  type OtioNode,
  type OtioDocumentV1,
  type OtioRationalTime,
  type OtioSourceSpan,
  type OtioTimeRange,
  openRelic,
  readOtioDocument,
  type RendererClass,
  resolveOtioAnchor,
  timeToSeconds,
} from '@relic/format';
import { boxPosition, type CommentRecord, formatTimecode } from './comments.ts';
import type { PublishDeps } from './publish.ts';
import { loadPublishState } from './state.ts';

const activeChildren = new Set<ChildProcess>();

export const DEFAULT_FFMPEG_TIMEOUT_MS = 15_000;
export const PROBE_FFMPEG_TIMEOUT_MS = 2_000;
/**
 * Maximum dimension in pixels for images returned in tool results.
 *
 * Images returned inline in MCP results consume the agent's context window.
 * Capping dimensions at 1200 pixels preserves fine visual detail (such as
 * product bevels, typography, and UI controls) while keeping base64 payload
 * sizes comfortably under 400 kilobytes per image, preventing context
 * exhaustion and avoiding downstream vision model downscaling artifacts.
 */
export const MAX_IMAGE_DIMENSION = 1200;

export interface ResolvedImageBlock {
  readonly type: 'image';
  readonly data: string;
  readonly mimeType: string;
}

export interface ResolvedTextBlock {
  readonly type: 'text';
  readonly text: string;
}

export type ContentBlock = ResolvedTextBlock | ResolvedImageBlock;

export interface OtioPathNode {
  readonly id: string;
  readonly name: string;
  readonly schema: string;
  readonly json_pointer: string;
}

export interface OtioIntersection {
  readonly node_id: string;
  readonly schema: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly json_pointer: string;
  readonly ancestry: readonly OtioPathNode[];
  readonly timeline_range: OtioTimeRange;
  readonly intersected_timeline_range: OtioTimeRange;
  readonly source_range: OtioTimeRange | null;
  readonly available_range: OtioTimeRange | null;
  readonly file_relative_source_range: OtioTimeRange | null;
  readonly source_mapping: OtioSourceSpan['source_mapping'];
  readonly active_media_reference_key: string | null;
  readonly bundle_path: string | null;
  readonly media_digest: string | null;
  readonly media_references: OtioSourceSpan['media_references'];
  readonly markers: OtioSourceSpan['markers'];
  readonly effects: OtioSourceSpan['effects'];
  readonly diagnostics: OtioSourceSpan['diagnostics'];
}

export interface OtioCurrentProjection {
  readonly current_version: number | null;
  readonly status:
    | 'same'
    | 'mapped'
    | 'partial'
    | 'changed'
    | 'ambiguous'
    | 'missing'
    | 'unresolvable';
  readonly explanation: string;
  readonly mapped_range?: OtioTimeRange;
  readonly mapped_ranges?: readonly OtioTimeRange[];
  readonly mapped_timeline_id?: string;
  readonly mapped_track_id?: string | null;
  readonly mapped_item_id?: string;
  readonly mapped_start_seconds?: number | null;
  readonly mapped_start_timecode?: string;
}

export type ResolvedAnchor =
  | {
      readonly kind: 'quote' | 'text';
      readonly status: 'resolved';
      readonly exact: string;
      readonly line: number;
      readonly context_before: string;
      readonly context_after: string;
    }
  | {
      readonly kind: 'quote' | 'text';
      readonly status: 'unresolvable';
      readonly explanation: string;
    }
  | {
      readonly kind: 'region';
      readonly status: 'resolved';
      readonly original_width: number;
      readonly original_height: number;
      readonly downscaled: boolean;
      readonly downscaled_width?: number | undefined;
      readonly downscaled_height?: number | undefined;
      readonly crop_box_pixels: {
        readonly x: number;
        readonly y: number;
        readonly w: number;
        readonly h: number;
      };
      readonly explanation?: string | undefined;
    }
  | {
      readonly kind: 'region';
      readonly status: 'unresolvable';
      readonly explanation: string;
    }
  | {
      readonly kind: 'time';
      readonly status: 'resolved';
      readonly t: number;
      readonly t_end?: number | undefined;
      readonly has_frames: boolean;
      readonly downscaled: boolean;
      readonly explanation?: string | undefined;
    }
  | {
      readonly kind: 'time';
      readonly status: 'unresolvable';
      readonly explanation: string;
      readonly t?: number | undefined;
      readonly t_end?: number | undefined;
      readonly has_frames?: boolean | undefined;
      readonly downscaled?: boolean | undefined;
    }
  | {
      readonly kind: 'page';
      readonly status: 'resolved' | 'unresolvable';
      readonly page: number;
      readonly explanation: string;
      readonly exact?: string | undefined;
      readonly rect?: AnchorRect | undefined;
    }
  | {
      readonly kind: 'pin';
      readonly status: 'unresolvable';
      readonly x: number;
      readonly y: number;
      readonly explanation: string;
    }
  | {
      readonly kind: 'unsupported';
      readonly status: 'unresolvable';
      readonly declared: string;
      readonly explanation: string;
    }
  | {
      readonly kind: 'otio';
      readonly status: 'resolved' | 'unresolvable';
      readonly explanation: string;
      readonly relic_version: number;
      readonly document_sha256: string;
      readonly snapshot: OtioAnchorV1['snapshot'];
      readonly timeline_id: string;
      readonly track_id: string | null;
      readonly item_id?: string;
      readonly timeline_path: readonly OtioPathNode[];
      readonly range: OtioTimeRange;
      readonly point: boolean;
      readonly start_seconds: number | null;
      readonly duration_seconds: number | null;
      readonly end_seconds: number | null;
      readonly start_timecode: string;
      readonly end_timecode: string;
      readonly intersections: readonly OtioIntersection[];
      readonly current_projection: OtioCurrentProjection;
    };
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let cachedSystemFfmpeg: string | null | undefined;

/**
 * Reset cached ffmpeg path for test isolation.
 */
export function resetFfmpegCacheForTest(): void {
  cachedSystemFfmpeg = undefined;
}

/**
 * Locate the ffmpeg binary, or return undefined when it is absent.
 *
 * Treated as optional at runtime. Respects dependency overrides and
 * environment variable toggles before probing known system paths.
 */
export async function probeFfmpeg(deps?: {
  ffmpegPath?: string | null | undefined;
}): Promise<string | undefined> {
  if (deps?.ffmpegPath === null) return undefined;
  if (typeof deps?.ffmpegPath === 'string') return deps.ffmpegPath;

  const env = process.env['RELIC_FFMPEG_PATH'];
  if (env === 'none' || env === 'disabled') return undefined;
  if (env) return env;

  if (cachedSystemFfmpeg !== undefined) {
    return cachedSystemFfmpeg ?? undefined;
  }

  const candidatePaths = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    'ffmpeg',
  ];

  for (const candidate of candidatePaths) {
    try {
      const { promise, resolve } = defer<boolean>();
      const child = spawn(candidate, ['-version'], { stdio: 'ignore' });
      activeChildren.add(child);

      let timer: NodeJS.Timeout | undefined = setTimeout(() => {
        timer = undefined;
        try {
          child.kill('SIGKILL');
          child.unref();
        } catch {
          // Process may have exited already.
        }
        activeChildren.delete(child);
        resolve(false);
      }, PROBE_FFMPEG_TIMEOUT_MS);

      const cleanup = () => {
        activeChildren.delete(child);
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      child.on('error', () => {
        cleanup();
        resolve(false);
      });
      child.on('close', (code) => {
        cleanup();
        resolve(code === 0);
      });
      const ok = await promise;
      if (ok) {
        cachedSystemFfmpeg = candidate;
        return candidate;
      }
    } catch {
      // Continue probing remaining candidate paths.
    }
  }

  cachedSystemFfmpeg = null;
  return undefined;
}
/**
 * Run ffmpeg with input bytes supplied through pipe:0, falling back to a
 * secure temporary file only when pipes fail on unseekable media.
 *
 * Plaintext bytes are kept in memory whenever possible. If ffmpeg cannot
 * seek within a piped stream (for instance, on certain MP4 files whose moov
 * atom sits at the end of the file), a temporary file is created with 0600
 * permissions in a private directory and deleted in a finally block.
 */
export async function runFfmpeg(
  ffmpegPath: string,
  args: readonly string[],
  inputBytes: Uint8Array,
  timeoutMs: number = DEFAULT_FFMPEG_TIMEOUT_MS
): Promise<Uint8Array> {
  const t0 = Date.now();
  try {
    return await runFfmpegPiped(ffmpegPath, args, inputBytes, timeoutMs);
  } catch (pipeError) {
    if (!args.includes('pipe:0') && !args.includes('pipe:1')) {
      throw pipeError;
    }
    const elapsed = Date.now() - t0;
    const remaining = timeoutMs - elapsed;
    if (remaining <= 0) {
      throw pipeError;
    }
    return await runFfmpegTemp(ffmpegPath, args, inputBytes, remaining);
  }
}

function runFfmpegPiped(
  ffmpegPath: string,
  args: readonly string[],
  inputBytes: Uint8Array,
  timeoutMs: number = DEFAULT_FFMPEG_TIMEOUT_MS
): Promise<Uint8Array> {
  const { promise, resolve, reject } = defer<Uint8Array>();
  const finalArgs = args.includes('-nostdin') ? args : ['-nostdin', ...args];
  const usesPipe0 = finalArgs.includes('pipe:0');
  const child = spawn(ffmpegPath, finalArgs, {
    stdio: [usesPipe0 ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  activeChildren.add(child);
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  if (timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
        child.unref();
      } catch {
        // Child may have exited already.
      }
      const onDone = () => {
        reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
      };
      if (child.exitCode !== null || child.signalCode !== null) {
        onDone();
      } else {
        child.once('close', onDone);
        setTimeout(onDone, 500);
      }
    }, timeoutMs);
  }
  const cleanup = () => {
    activeChildren.delete(child);
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  child.stdout?.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
  child.stderr?.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});
  child.on('error', (err) => {
    cleanup();
    if (!timedOut) {
      reject(err);
    }
  });

  child.on('close', (code, signal) => {
    cleanup();
    if (timedOut) return;
    if (code !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      reject(
        new Error(`ffmpeg exited with code ${code} signal ${signal}: ${stderr}`)
      );
    } else {
      resolve(new Uint8Array(Buffer.concat(stdoutChunks)));
    }
  });

  if (usesPipe0 && child.stdin) {
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE' && !timedOut) {
        cleanup();
        reject(err);
      }
    });
    child.stdin.end(Buffer.from(inputBytes));
  }
  return promise;
}

export async function runFfmpegTemp(
  ffmpegPath: string,
  args: readonly string[],
  inputBytes: Uint8Array,
  timeoutMs: number = DEFAULT_FFMPEG_TIMEOUT_MS
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'relic-media-'));
  await chmod(dir, 0o700);
  const tempPath = join(dir, 'content.bin');
  const tempOutPath = join(dir, 'output.bin');
  try {
    if (args.includes('pipe:0')) {
      await writeFile(tempPath, inputBytes, { mode: 0o600 });
    }
    const usesPipe1 = args.includes('pipe:1');
    const adjustedArgs = args.map((arg) => {
      if (arg === 'pipe:0') return tempPath;
      if (arg === 'pipe:1') return tempOutPath;
      return arg;
    });
    const finalArgs = adjustedArgs.includes('-nostdin')
      ? adjustedArgs
      : ['-nostdin', ...adjustedArgs];

    const { promise, resolve, reject } = defer<Uint8Array>();
    const child = usesPipe1
      ? spawn(ffmpegPath, finalArgs, { stdio: ['ignore', 'ignore', 'pipe'] })
      : spawn(ffmpegPath, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    activeChildren.add(child);

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
          child.unref();
        } catch {
          // Child may have exited already.
        }
        const onDone = () => {
          reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
        };
        if (child.exitCode !== null || child.signalCode !== null) {
          onDone();
        } else {
          child.once('close', onDone);
          setTimeout(onDone, 500);
        }
      }, timeoutMs);
    }
    const cleanup = () => {
      activeChildren.delete(child);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    if (!usesPipe1 && child.stdout) {
      child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
      child.stdout.on('error', () => {});
    }
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.stderr.on('error', () => {});
    child.on('error', (err) => {
      cleanup();
      if (!timedOut) reject(err);
    });
    child.on('close', async (code, signal) => {
      cleanup();
      if (timedOut) return;
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8');
        reject(
          new Error(
            `ffmpeg exited with code ${code} signal ${signal}: ${stderr}`
          )
        );
      } else {
        if (usesPipe1) {
          try {
            const outBytes = await readFile(tempOutPath);
            resolve(new Uint8Array(outBytes));
          } catch (readErr) {
            reject(readErr);
          }
        } else {
          resolve(new Uint8Array(Buffer.concat(stdoutChunks)));
        }
      }
    });
    return await promise;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Fast synchronous dimension extractor for standard image headers.
 *
 * Avoids spawning a child process when the dimensions can be parsed directly
 * from the first few bytes of the container payload.
 */
export function parseImageDimensions(
  bytes: Uint8Array
): { width: number; height: number } | undefined {
  // PNG: bytes 16..24 contain uint32 big-endian width and height.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16, false);
    const height = view.getUint32(20, false);
    if (width > 0 && height > 0) return { width, height };
  }

  // GIF: bytes 6..10 contain uint16 little-endian width and height.
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint16(6, true);
    const height = view.getUint16(8, true);
    if (width > 0 && height > 0) return { width, height };
  }

  // JPEG: scan markers for SOF0 (0xFFC0), SOF1 (0xFFC1), or SOF2 (0xFFC2).
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1];
      // Skip fill bytes or restart markers
      if (
        marker === 0xff ||
        (marker !== undefined && marker >= 0xd0 && marker <= 0xd7) ||
        marker === 0x01
      ) {
        offset += 1;
        continue;
      }
      if (marker === 0xd9) break; // EOI
      const segmentLength = view.getUint16(offset + 2, false);
      if (
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb
      ) {
        const height = view.getUint16(offset + 5, false);
        const width = view.getUint16(offset + 7, false);
        if (width > 0 && height > 0) return { width, height };
      }
      offset += 2 + segmentLength;
    }
  }

  return undefined;
}

/**
 * Fallback dimension probe using ffmpeg stderr output when header parsing
 * does not recognise the format (such as WebP or video containers).
 */
export async function probeMediaDimensionsWithFfmpeg(
  ffmpegPath: string,
  bytes: Uint8Array,
  timeoutMs: number = DEFAULT_FFMPEG_TIMEOUT_MS
): Promise<{ width: number; height: number } | undefined> {
  try {
    const { promise, resolve } = defer<
      { width: number; height: number } | undefined
    >();
    const child = spawn(
      ffmpegPath,
      ['-nostdin', '-i', 'pipe:0', '-f', 'null', '-'],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
      }
    );
    activeChildren.add(child);

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill('SIGKILL');
          child.unref();
        } catch {
          // Process may have exited already.
        }
        cleanup();
        resolve(undefined);
      }, timeoutMs);
    }
    const cleanup = () => {
      activeChildren.delete(child);
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    };

    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.stderr.on('error', () => {});
    child.on('error', () => {
      cleanup();
      if (!timedOut) resolve(undefined);
    });
    child.on('close', () => {
      cleanup();
      if (timedOut) return;
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      const match = stderr.match(/Video:.*?,\s*(\d{2,5})x(\d{2,5})/);
      if (match?.[1] && match[2]) {
        const width = Number.parseInt(match[1], 10);
        const height = Number.parseInt(match[2], 10);
        if (width > 0 && height > 0) {
          resolve({ width, height });
          return;
        }
      }
      resolve(undefined);
    });
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(bytes));
    return await promise;
  } catch {
    return undefined;
  }
}

type RelicFetch =
  | {
      readonly ok: true;
      readonly opened: OpenedRelic;
      readonly version: number;
      readonly currentVersion: number;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

/**
 * Fetch and decrypt one relic revision.
 *
 * `requestedVersion` is the relic revision, posted to mint. Decryption always
 * uses format version 1. Those are different version domains: passing the
 * revision into `openRelic` rejects a valid container.
 */
async function fetchAndDecryptRelic(
  relicId: string,
  deps: PublishDeps,
  requestedVersion?: number
): Promise<RelicFetch> {
  const state = await loadPublishState(relicId);
  if (!state || !state.key) {
    return {
      ok: false,
      error:
        'No local publish state or decryption key found on this machine for this relic.',
    };
  }

  let mint: {
    url: string;
    object_length: number;
    version?: number;
    current_version?: number;
  };
  try {
    const mintResponse = await deps.fetch(
      `${deps.serviceOrigin}/api/relics/${relicId}/mint`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          requestedVersion === undefined ? {} : { version: requestedVersion }
        ),
      }
    );
    if (!mintResponse.ok) {
      if (mintResponse.status === 404 || mintResponse.status === 410) {
        return {
          ok: false,
          error:
            'Relic was not found or has expired on the service, so its content cannot be retrieved.',
        };
      }
      return {
        ok: false,
        error: `Failed to mint download URL: HTTP status ${mintResponse.status}.`,
      };
    }
    mint = (await mintResponse.json()) as {
      url: string;
      object_length: number;
      version?: number;
      current_version?: number;
    };
  } catch (error) {
    return {
      ok: false,
      error: `Network error reaching relic service: ${(error as Error).message}.`,
    };
  }

  const servedVersion =
    typeof mint.version === 'number' ? mint.version : requestedVersion;
  const currentVersion =
    typeof mint.current_version === 'number'
      ? mint.current_version
      : servedVersion;
  if (servedVersion === undefined || currentVersion === undefined) {
    return {
      ok: false,
      error:
        'The service mint did not name the relic revision, so historical content was not decrypted against a guessed version.',
    };
  }
  if (requestedVersion !== undefined && servedVersion !== requestedVersion) {
    return {
      ok: false,
      error: `Requested relic version ${requestedVersion} but the service returned version ${servedVersion}.`,
    };
  }

  try {
    const containerResponse = await deps.fetch(mint.url);
    if (!containerResponse.ok) {
      return {
        ok: false,
        error: `Failed to fetch relic ciphertext: HTTP status ${containerResponse.status}.`,
      };
    }
    const containerBytes = new Uint8Array(
      await containerResponse.arrayBuffer()
    );
    const key = decodeKey(state.key);
    const opened = await openRelic(containerBytes, key, FORMAT_VERSION);
    return {
      ok: true,
      opened,
      version: servedVersion,
      currentVersion,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to decrypt relic content: ${(error as Error).message}.`,
    };
  }
}

/**
 * Locate a target string in text and select the occurrence matching prefix and suffix.
 */
function findTextOccurrence(
  fullText: string,
  target: string,
  prefix?: string,
  suffix?: string
): { matchIndex: number; line: number } | undefined {
  if (target.length === 0) return undefined;

  const candidates: number[] = [];
  let searchPos = 0;
  while (true) {
    const found = fullText.indexOf(target, searchPos);
    if (found === -1) break;
    candidates.push(found);
    searchPos = found + 1;
  }

  if (candidates.length === 0) return undefined;
  if (candidates.length === 1 && candidates[0] !== undefined) {
    const matchIndex = candidates[0];
    const line = fullText.slice(0, matchIndex).split('\n').length;
    return { matchIndex, line };
  }

  let bestIndex = candidates[0] ?? 0;
  let bestScore = -1;

  for (const cand of candidates) {
    let score = 0;
    if (prefix && prefix.length > 0) {
      const before = fullText.slice(Math.max(0, cand - prefix.length), cand);
      if (before === prefix) {
        score += 2;
      } else if (before.endsWith(prefix) || prefix.endsWith(before)) {
        score += 1;
      }
    }
    if (suffix && suffix.length > 0) {
      const after = fullText.slice(
        cand + target.length,
        cand + target.length + suffix.length
      );
      if (after === suffix) {
        score += 2;
      } else if (after.startsWith(suffix) || suffix.startsWith(after)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestIndex = cand;
    }
  }

  const line = fullText.slice(0, bestIndex).split('\n').length;
  return { matchIndex: bestIndex, line };
}

const nodeInflater: InflaterFn = (compressed, uncompressedSize, maxBytes) => {
  if (
    !Number.isSafeInteger(uncompressedSize) ||
    uncompressedSize < 0 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0
  ) {
    return Promise.reject(
      new Error('decompression sizes must be non-negative safe integers')
    );
  }
  if (uncompressedSize > maxBytes) {
    return Promise.reject(
      new Error(
        `declared decompressed size ${uncompressedSize} exceeds ${maxBytes}`
      )
    );
  }

  const { promise, resolve, reject } = defer<Uint8Array>();
  try {
    // zlib requires a positive cap; an empty entry still has a zero-byte result budget.
    inflateRaw(
      compressed,
      { maxOutputLength: Math.max(1, maxBytes) },
      (error, result) => {
        if (error) {
          reject(error);
          return;
        }
        if (result.length > maxBytes) {
          reject(
            new Error(`inflated size ${result.length} exceeds ${maxBytes}`)
          );
          return;
        }
        resolve(result);
      }
    );
  } catch (error) {
    reject(error);
  }
  return promise;
};

type OtioParse =
  | { readonly ok: true; readonly document: OtioDocumentV1 }
  | { readonly ok: false; readonly error: string };

async function parseOpenedOtio(opened: OpenedRelic): Promise<OtioParse> {
  try {
    const filename = opened.envelope.entries[0]?.filename ?? '';
    let source = opened.content;
    let mediaIndex: Record<string, OtioMediaEntry> = Object.create(null);
    if (isOtioz(opened.content) || filename.toLowerCase().endsWith('.otioz')) {
      const index = await indexOtioZip(opened.content, {
        inflater: nodeInflater,
      });
      source = index.contentOtioBytes;
      mediaIndex = await otioBundleMediaIndex(index, { digests: true });
    } else if (
      !isRawOtio(opened.content) &&
      !filename.toLowerCase().endsWith('.otio')
    ) {
      return {
        ok: false,
        error: `Relic content is not an OTIO document${filename ? ` (${filename})` : ''}.`,
      };
    }
    return {
      ok: true,
      document: readOtioDocument(source, { mediaIndex }),
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to read OTIO document: ${(error as Error).message}.`,
    };
  }
}

function secondsOf(time: OtioRationalTime): number | null {
  try {
    return timeToSeconds(time);
  } catch {
    return null;
  }
}

function displayTimecode(
  time: OtioRationalTime,
  globalStart?: OtioRationalTime
): string {
  if (
    !Number.isFinite(time.value) ||
    !Number.isFinite(time.rate) ||
    time.rate <= 0
  ) {
    return 'unknown';
  }
  const shifted =
    globalStart && globalStart.rate > 0
      ? time.value + globalStart.value * (time.rate / globalStart.rate)
      : time.value;
  const fps = Math.max(1, Math.round(time.rate));
  const total = Math.max(0, Math.round(shifted));
  const frames = total % fps;
  const wholeSeconds = Math.floor(total / fps);
  const seconds = wholeSeconds % 60;
  const minutes = Math.floor(wholeSeconds / 60) % 60;
  const hours = Math.floor(wholeSeconds / 3600);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(frames)}`;
}

function ancestry(
  document: OtioDocumentV1,
  nodeId: string
): readonly OtioPathNode[] {
  const chain: OtioPathNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = nodeId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node: OtioNode | undefined = document.nodes[cursor];
    if (!node) break;
    chain.unshift({
      id: node.id,
      name: node.name,
      schema: node.schema,
      json_pointer: node.json_pointer,
    });
    cursor = node.parent_id;
  }
  return chain;
}

function intersectionsFor(
  document: OtioDocumentV1,
  spans: readonly OtioSourceSpan[]
): readonly OtioIntersection[] {
  return spans.map((span) => {
    const node = document.nodes[span.node_id];
    return {
      node_id: span.node_id,
      schema: span.schema,
      name: span.name,
      enabled: span.enabled,
      json_pointer: node?.json_pointer ?? '',
      ancestry: ancestry(document, span.node_id),
      timeline_range: span.timeline_range,
      intersected_timeline_range: span.intersected_timeline_range,
      source_range: span.source_range,
      available_range: span.available_range,
      file_relative_source_range: span.file_relative_source_range,
      source_mapping: span.source_mapping,
      active_media_reference_key: span.active_media_reference_key,
      bundle_path: span.bundle_path,
      media_digest:
        span.bundle_path === null
          ? null
          : (document.media[span.bundle_path]?.sha256 ?? null),
      media_references: span.media_references,
      markers: span.markers,
      effects: span.effects,
      diagnostics: span.diagnostics,
    };
  });
}

function rangeClock(
  range: OtioTimeRange,
  globalStart?: OtioRationalTime
): {
  readonly point: boolean;
  readonly start_seconds: number | null;
  readonly duration_seconds: number | null;
  readonly end_seconds: number | null;
  readonly start_timecode: string;
  readonly end_timecode: string;
} {
  const startSeconds = secondsOf(range.start_time);
  const durationSeconds = secondsOf(range.duration);
  const endSeconds =
    startSeconds === null || durationSeconds === null
      ? null
      : startSeconds + durationSeconds;
  const endTime = {
    value:
      range.start_time.value +
      range.duration.value * (range.start_time.rate / range.duration.rate),
    rate: range.start_time.rate,
  };
  return {
    point: range.duration.value === 0,
    start_seconds: startSeconds,
    duration_seconds: durationSeconds,
    end_seconds: endSeconds,
    start_timecode: displayTimecode(range.start_time, globalStart),
    end_timecode: displayTimecode(endTime, globalStart),
  };
}

function documentFor(
  version: number,
  loadRevision: (version: number | undefined) => Promise<RelicFetch>,
  documents: Map<number, Promise<OtioParse>>
): Promise<OtioParse> {
  let pending = documents.get(version);
  if (!pending) {
    pending = loadRevision(version).then((fetched) =>
      fetched.ok
        ? parseOpenedOtio(fetched.opened)
        : { ok: false as const, error: fetched.error }
    );
    documents.set(version, pending);
  }
  return pending;
}

function projectionExplanation(
  status: OtioCurrentProjection['status']
): string {
  switch (status) {
    case 'same':
      return 'The current revision still contains this range.';
    case 'mapped':
      return 'The source interval maps uniquely into the current revision.';
    case 'partial':
      return 'Only part of the source interval remains in the current revision. The mapped range is that overlap, not a clamp of the original.';
    case 'changed':
      return 'The current revision changed this region. No coordinate was guessed.';
    case 'ambiguous':
      return 'More than one current item matches, or the mapping is not invertible. Duplicate clips were not guessed.';
    case 'missing':
      return 'The marked item or interval is absent from the current revision. It was not clamped into a nearby range.';
    case 'unresolvable':
      return 'The current revision could not be read.';
  }
}

const OTIO_ANCHOR_VERSION_UNSTAMPED =
  'The service did not stamp this comment with a usable revision, so the sealed OTIO anchor revision cannot be verified and artifact content was not fetched.';
const OTIO_ANCHOR_VERSION_MISMATCH =
  'The sealed OTIO anchor revision does not match the service-stamped comment version, so artifact content was not fetched.';
const OTIO_DOCUMENT_DIGEST_MISMATCH =
  'The sealed OTIO document digest does not match the requested revision, so artifact-derived context was withheld.';
const OTIO_SOURCE_ANCHOR_INVALID =
  'The sealed OTIO anchor does not identify a valid source location in its revision, so artifact-derived context was withheld.';

async function resolveOtioComment(
  comment: CommentRecord,
  anchor: OtioAnchorV1,
  loadRevision: (version: number | undefined) => Promise<RelicFetch>,
  documents: Map<number, Promise<OtioParse>>
): Promise<CommentRecord> {
  const clock = rangeClock(anchor.range);
  const base = {
    relic_version: anchor.relic_version,
    document_sha256: anchor.document_sha256,
    snapshot: anchor.snapshot,
    timeline_id: anchor.timeline_id,
    track_id: anchor.track_id,
    ...(anchor.item_id === undefined ? {} : { item_id: anchor.item_id }),
    range: anchor.range,
    point: clock.point,
    start_seconds: clock.start_seconds,
    duration_seconds: clock.duration_seconds,
    end_seconds: clock.end_seconds,
    start_timecode: clock.start_timecode,
    end_timecode: clock.end_timecode,
  };
  const unresolvable = (
    explanation: string,
    projectionExplanation: string
  ): CommentRecord => ({
    ...comment,
    resolved: {
      kind: 'otio',
      status: 'unresolvable',
      explanation,
      timeline_path: [],
      intersections: [],
      current_projection: {
        status: 'unresolvable',
        current_version: null,
        explanation: projectionExplanation,
      },
      ...base,
    },
  });
  const projectionFromCore = (
    projected: OtioAnchorResolution,
    currentVersion: number,
    currentDocument: OtioDocumentV1
  ): OtioCurrentProjection => {
    const copied: {
      status: OtioCurrentProjection['status'];
      current_version: number;
      explanation: string;
      mapped_ranges?: readonly OtioTimeRange[];
      mapped_timeline_id?: string;
      mapped_track_id?: string | null;
      mapped_item_id?: string;
    } = {
      status: projected.status,
      current_version: currentVersion,
      explanation: projectionExplanation(projected.status),
    };
    if (projected.mapped_ranges !== undefined) {
      copied.mapped_ranges = projected.mapped_ranges;
    }
    if (projected.mapped_timeline_id !== undefined) {
      copied.mapped_timeline_id = projected.mapped_timeline_id;
    }
    if (projected.mapped_track_id !== undefined) {
      copied.mapped_track_id = projected.mapped_track_id;
    }
    if (projected.mapped_item_id !== undefined) {
      copied.mapped_item_id = projected.mapped_item_id;
    }

    const mappedRange = projected.mapped_range;
    if (mappedRange === undefined) return copied;

    const mappedClock = rangeClock(
      mappedRange,
      projected.mapped_timeline_id === undefined
        ? undefined
        : currentDocument.global_start_times?.[projected.mapped_timeline_id]
    );
    return {
      ...copied,
      mapped_range: mappedRange,
      mapped_start_seconds: mappedClock.start_seconds,
      mapped_start_timecode: mappedClock.start_timecode,
    };
  };

  if (
    typeof comment.version !== 'number' ||
    !Number.isSafeInteger(comment.version) ||
    comment.version < 1
  ) {
    return unresolvable(
      OTIO_ANCHOR_VERSION_UNSTAMPED,
      OTIO_ANCHOR_VERSION_UNSTAMPED
    );
  }
  if (comment.version !== anchor.relic_version) {
    return unresolvable(
      OTIO_ANCHOR_VERSION_MISMATCH,
      OTIO_ANCHOR_VERSION_MISMATCH
    );
  }

  const original = await documentFor(
    anchor.relic_version,
    loadRevision,
    documents
  );
  if (!original.ok) {
    return unresolvable(
      original.error,
      'The original revision could not be read, so no current projection was attempted.'
    );
  }

  const document = original.document;
  if (document.document_sha256 !== anchor.document_sha256) {
    return unresolvable(
      OTIO_DOCUMENT_DIGEST_MISMATCH,
      OTIO_DOCUMENT_DIGEST_MISMATCH
    );
  }

  const originalProjection = resolveOtioAnchor(anchor, document);
  if (originalProjection.status !== 'same') {
    return unresolvable(OTIO_SOURCE_ANCHOR_INVALID, OTIO_SOURCE_ANCHOR_INVALID);
  }

  const spans = originalProjection.source_spans;
  const timelinePath = ancestry(
    document,
    anchor.track_id ?? anchor.timeline_id
  );
  const globalStart = document.global_start_times?.[anchor.timeline_id];
  const displayed = rangeClock(anchor.range, globalStart);

  const latest = await loadRevision(undefined);
  let currentProjection: OtioCurrentProjection;
  if (!latest.ok) {
    currentProjection = {
      status: 'unresolvable',
      current_version: null,
      explanation: latest.error,
    };
  } else if (latest.version === anchor.relic_version) {
    currentProjection = projectionFromCore(
      resolveOtioAnchor(anchor, document, document),
      latest.currentVersion,
      document
    );
  } else {
    const current = await documentFor(latest.version, loadRevision, documents);
    if (!current.ok) {
      currentProjection = {
        status: 'unresolvable',
        current_version: latest.currentVersion,
        explanation: current.error,
      };
    } else {
      currentProjection = projectionFromCore(
        resolveOtioAnchor(anchor, document, current.document),
        latest.currentVersion,
        current.document
      );
    }
  }

  return {
    ...comment,
    resolved: {
      kind: 'otio',
      status: 'resolved',
      explanation:
        `Original revision ${anchor.relic_version} on ${anchor.snapshot.timeline}` +
        `${anchor.snapshot.track ? ` / ${anchor.snapshot.track}` : ''}.`,
      timeline_path: timelinePath,
      intersections: intersectionsFor(document, spans),
      current_projection: currentProjection,
      ...base,
      start_timecode: displayed.start_timecode,
      end_timecode: displayed.end_timecode,
    },
  };
}

/**
 * Resolve anchors against the revision each comment was made on.
 *
 * Historical reads post `{ version }` and decrypt format version 1. The
 * latest server revision is learned from the mint response, never from local
 * publish state. One failed revision does not blank every other comment.
 */
export async function resolveAnchors(
  relicId: string,
  comments: readonly CommentRecord[],
  deps: PublishDeps
): Promise<{
  readonly comments: readonly CommentRecord[];
  readonly imageBlocks: readonly ResolvedImageBlock[];
}> {
  if (comments.length === 0) {
    return { comments, imageBlocks: [] };
  }

  const hasAnyAnchor = comments.some((c) => c.readable && c.anchor !== null);
  if (!hasAnyAnchor) {
    return { comments, imageBlocks: [] };
  }

  // OTIO version and digest gates decide whether their revisions may be read.
  // Eagerly loading the batch would fetch a latest revision for a rejected seal.
  const loads = new Map<string, Promise<RelicFetch>>();
  const loadRevision = (version: number | undefined): Promise<RelicFetch> => {
    const key = version === undefined ? 'latest' : String(version);
    let pending = loads.get(key);
    if (!pending) {
      pending = fetchAndDecryptRelic(relicId, deps, version);
      loads.set(key, pending);
    }
    return pending;
  };
  const documents = new Map<number, Promise<OtioParse>>();

  const updatedComments: CommentRecord[] = [];
  const imageBlocks: ResolvedImageBlock[] = [];
  let opened: OpenedRelic | undefined;
  let filename = '';
  let rendererClass: RendererClass = 'binary';
  let isImage = false;
  let isAudio = false;
  let isVideo = false;
  let isPdf = false;

  for (const comment of comments) {
    if (!comment.readable || comment.anchor === null) {
      updatedComments.push(comment);
      continue;
    }

    const { anchor } = comment;
    if (anchor.kind === 'otio') {
      updatedComments.push(
        await resolveOtioComment(comment, anchor, loadRevision, documents)
      );
      continue;
    }
    if (anchor.kind === 'unsupported') {
      const futureOtio = anchor.declared.startsWith('otio-v');
      updatedComments.push({
        ...comment,
        resolved: {
          kind: 'unsupported',
          status: 'unresolvable',
          declared: anchor.declared,
          explanation: futureOtio
            ? `Unsupported OTIO anchor version "${anchor.declared}". A newer anchor version is not evidence the comment was tampered with.`
            : `Unsupported anchor kind "${anchor.declared}".`,
        },
      });
      continue;
    }

    const fetched = await loadRevision(comment.version ?? undefined);
    if (!fetched.ok) {
      updatedComments.push({
        ...comment,
        resolved: {
          kind: anchor.kind,
          status: 'unresolvable',
          explanation: fetched.error,
        } as ResolvedAnchor,
      });
      continue;
    }
    opened = fetched.opened;
    const entry = opened.envelope.entries[0];
    filename = entry?.filename ?? '';
    const mimetype = entry?.mimetype ?? '';
    rendererClass = deriveRendererClass(opened.content, filename);
    isImage =
      rendererClass === 'image' ||
      mimetype.startsWith('image/') ||
      /\.(png|jpe?g|webp|gif|bmp|svg)$/i.test(filename);
    isAudio =
      mimetype.startsWith('audio/') ||
      /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(filename);
    isVideo =
      mimetype.startsWith('video/') ||
      /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(filename) ||
      (rendererClass === 'media' && !isAudio);
    isPdf =
      mimetype === 'application/pdf' ||
      /\.pdf$/i.test(filename) ||
      (opened.content.length >= 4 &&
        opened.content[0] === 0x25 &&
        opened.content[1] === 0x50 &&
        opened.content[2] === 0x44 &&
        opened.content[3] === 0x46);

    switch (anchor.kind) {
      case 'text':
      case 'quote': {
        const target = anchor.kind === 'text' ? anchor.quote : anchor.exact;
        const prefix = anchor.kind === 'quote' ? anchor.prefix : undefined;
        const suffix = anchor.kind === 'quote' ? anchor.suffix : undefined;

        if (isImage || isVideo || isAudio) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: anchor.kind,
              status: 'unresolvable',
              explanation: `A text quote anchor cannot be resolved against a ${rendererClass} relic.`,
            },
          });
          break;
        }

        const fullText = new TextDecoder('utf-8', { fatal: false }).decode(
          opened.content
        );
        const match = findTextOccurrence(fullText, target, prefix, suffix);

        if (!match) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: anchor.kind,
              status: 'unresolvable',
              explanation:
                'The quoted text was not found in the current relic content (it may have been edited or removed in a newer version).',
            },
          });
          break;
        }

        const contextBefore = fullText.slice(
          Math.max(0, match.matchIndex - 120),
          match.matchIndex
        );
        const contextAfter = fullText.slice(
          match.matchIndex + target.length,
          Math.min(fullText.length, match.matchIndex + target.length + 120)
        );

        updatedComments.push({
          ...comment,
          resolved: {
            kind: anchor.kind,
            status: 'resolved',
            exact: target,
            line: match.line,
            context_before: contextBefore,
            context_after: contextAfter,
          },
        });
        break;
      }

      case 'region': {
        if (!isImage) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation: `Region anchor cannot be resolved against a non-image relic (type: ${rendererClass}).`,
            },
          });
          break;
        }

        const ffmpegPath = await probeFfmpeg(deps);
        if (!ffmpegPath) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation: `ffmpeg is not available on this machine to process image regions. Region: ${boxPosition(anchor.rect)}.`,
            },
          });
          break;
        }

        let dims = parseImageDimensions(opened.content);
        if (!dims) {
          dims = await probeMediaDimensionsWithFfmpeg(
            ffmpegPath,
            opened.content
          );
        }

        if (!dims) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation:
                'Could not determine image dimensions for region crop.',
            },
          });
          break;
        }

        const origW = dims.width;
        const origH = dims.height;
        const cropX = Math.max(
          0,
          Math.min(origW - 1, Math.round(anchor.rect.x * origW))
        );
        const cropY = Math.max(
          0,
          Math.min(origH - 1, Math.round(anchor.rect.y * origH))
        );
        const cropW = Math.max(
          1,
          Math.min(origW - cropX, Math.round(anchor.rect.w * origW))
        );
        const cropH = Math.max(
          1,
          Math.min(origH - cropY, Math.round(anchor.rect.h * origH))
        );

        const isDownscaled =
          origW > MAX_IMAGE_DIMENSION || origH > MAX_IMAGE_DIMENSION;

        try {
          const cropFilter = `crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY},scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;
          const cropBytes = await runFfmpeg(
            ffmpegPath,
            [
              '-i',
              'pipe:0',
              '-vf',
              cropFilter,
              '-frames:v',
              '1',
              '-f',
              'image2',
              '-c:v',
              'png',
              'pipe:1',
            ],
            opened.content
          );

          const boxThickness = Math.max(
            2,
            Math.round(Math.min(origW, origH) * 0.005)
          );
          const annotatedFilter = `drawbox=x=${cropX}:y=${cropY}:w=${cropW}:h=${cropH}:color=red:t=${boxThickness},scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;
          const annotatedBytes = await runFfmpeg(
            ffmpegPath,
            [
              '-i',
              'pipe:0',
              '-vf',
              annotatedFilter,
              '-frames:v',
              '1',
              '-f',
              'image2',
              '-c:v',
              'png',
              'pipe:1',
            ],
            opened.content
          );

          imageBlocks.push({
            type: 'image',
            data: Buffer.from(cropBytes).toString('base64'),
            mimeType: 'image/png',
          });

          imageBlocks.push({
            type: 'image',
            data: Buffer.from(annotatedBytes).toString('base64'),
            mimeType: 'image/png',
          });

          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'resolved',
              original_width: origW,
              original_height: origH,
              downscaled: isDownscaled,
              crop_box_pixels: {
                x: cropX,
                y: cropY,
                w: cropW,
                h: cropH,
              },
            },
          });
        } catch (error) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'region',
              status: 'unresolvable',
              explanation: `Failed to crop or annotate image with ffmpeg: ${(error as Error).message}.`,
            },
          });
        }
        break;
      }

      case 'time': {
        if (isAudio) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              t: anchor.t,
              t_end: anchor.t_end,
              has_frames: false,
              downscaled: false,
              explanation: `Audio relics have no visual frames to display. Timecode: ${formatTimecode(anchor.t)}${anchor.t_end !== undefined ? ` to ${formatTimecode(anchor.t_end)}` : ''}.`,
            },
          });
          break;
        }

        if (!isVideo) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              explanation: `Time anchor cannot be resolved against a non-video relic (type: ${rendererClass}).`,
            },
          });
          break;
        }

        const ffmpegPath = await probeFfmpeg(deps);
        if (!ffmpegPath) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              explanation: `ffmpeg is not available on this machine to extract video frames. Video timestamp: ${formatTimecode(anchor.t)}${anchor.t_end !== undefined ? ` to ${formatTimecode(anchor.t_end)}` : ''}.`,
            },
          });
          break;
        }

        const scaleFilter = `scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;

        try {
          const frame1Bytes = await runFfmpeg(
            ffmpegPath,
            [
              '-ss',
              String(anchor.t),
              '-i',
              'pipe:0',
              '-frames:v',
              '1',
              '-vf',
              scaleFilter,
              '-f',
              'image2',
              '-c:v',
              'png',
              'pipe:1',
            ],
            opened.content
          );

          if (!frame1Bytes || frame1Bytes.length === 0) {
            updatedComments.push({
              ...comment,
              resolved: {
                kind: 'time',
                status: 'unresolvable',
                explanation: `Timestamp ${formatTimecode(anchor.t)} could not be extracted (may be beyond video duration).`,
              },
            });
            break;
          }

          imageBlocks.push({
            type: 'image',
            data: Buffer.from(frame1Bytes).toString('base64'),
            mimeType: 'image/png',
          });

          if (anchor.t_end !== undefined) {
            try {
              const frame2Bytes = await runFfmpeg(
                ffmpegPath,
                [
                  '-ss',
                  String(anchor.t_end),
                  '-i',
                  'pipe:0',
                  '-frames:v',
                  '1',
                  '-vf',
                  scaleFilter,
                  '-f',
                  'image2',
                  '-c:v',
                  'png',
                  'pipe:1',
                ],
                opened.content
              );
              if (frame2Bytes && frame2Bytes.length > 0) {
                imageBlocks.push({
                  type: 'image',
                  data: Buffer.from(frame2Bytes).toString('base64'),
                  mimeType: 'image/png',
                });
              }
            } catch {
              // If span end frame fails, proceed with the first frame
            }
          }

          if (anchor.rect) {
            const frameDims = parseImageDimensions(frame1Bytes);
            if (frameDims) {
              const cropX = Math.max(
                0,
                Math.min(
                  frameDims.width - 1,
                  Math.round(anchor.rect.x * frameDims.width)
                )
              );
              const cropY = Math.max(
                0,
                Math.min(
                  frameDims.height - 1,
                  Math.round(anchor.rect.y * frameDims.height)
                )
              );
              const cropW = Math.max(
                1,
                Math.min(
                  frameDims.width - cropX,
                  Math.round(anchor.rect.w * frameDims.width)
                )
              );
              const cropH = Math.max(
                1,
                Math.min(
                  frameDims.height - cropY,
                  Math.round(anchor.rect.h * frameDims.height)
                )
              );
              const frameCropFilter = `crop=w=${cropW}:h=${cropH}:x=${cropX}:y=${cropY},scale='min(${MAX_IMAGE_DIMENSION},iw)':'min(${MAX_IMAGE_DIMENSION},ih)':force_original_aspect_ratio=decrease`;
              const frameCropBytes = await runFfmpeg(
                ffmpegPath,
                [
                  '-i',
                  'pipe:0',
                  '-vf',
                  frameCropFilter,
                  '-frames:v',
                  '1',
                  '-f',
                  'image2',
                  '-c:v',
                  'png',
                  'pipe:1',
                ],
                frame1Bytes
              );
              imageBlocks.push({
                type: 'image',
                data: Buffer.from(frameCropBytes).toString('base64'),
                mimeType: 'image/png',
              });
            }
          }

          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'resolved',
              t: anchor.t,
              t_end: anchor.t_end,
              has_frames: true,
              downscaled: false,
            },
          });
        } catch (error) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'time',
              status: 'unresolvable',
              explanation: `Failed to extract video frame at timestamp ${formatTimecode(anchor.t)}: ${(error as Error).message}.`,
            },
          });
        }
        break;
      }

      case 'page': {
        if (!isPdf) {
          updatedComments.push({
            ...comment,
            resolved: {
              kind: 'page',
              status: 'unresolvable',
              page: anchor.page,
              explanation: `Page anchor cannot be resolved against a non-PDF relic (type: ${rendererClass}).`,
            },
          });
          break;
        }

        updatedComments.push({
          ...comment,
          resolved: {
            kind: 'page',
            status: 'resolved',
            page: anchor.page,
            exact: anchor.exact,
            rect: anchor.rect,
            explanation: `PDF page ${anchor.page} (server-side PDF page rendering is omitted to avoid heavy client dependencies).${anchor.rect ? ` Region on page: ${boxPosition(anchor.rect)}.` : ''}`,
          },
        });
        break;
      }

      case 'pin': {
        updatedComments.push({
          ...comment,
          resolved: {
            kind: 'pin',
            status: 'unresolvable',
            x: anchor.x,
            y: anchor.y,
            explanation: `Stage-relative pin at (${Math.round(anchor.x * 100)}%, ${Math.round(anchor.y * 100)}%). Pins are placed relative to the viewer stage rather than the content itself, so they cannot be resolved against artifact content with fidelity.`,
          },
        });
        break;
      }
    }
  }

  return { comments: updatedComments, imageBlocks };
}
