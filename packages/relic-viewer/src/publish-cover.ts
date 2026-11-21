import {
  deriveRendererClass,
  isRawOtio,
  modelFormatFromFilename,
  modelFormatFromMime,
  sniffContentClass,
  sniffModelFormat,
} from '@relic/format';
import {
  COVER_CAP_BYTES,
  COVER_HEIGHT,
  COVER_WIDTH,
  type CoverKind,
  type CoverType,
  validateCoverRaster,
} from '@relic/format/cover';
import { imageFormatOf } from '@relic/format/notebook';
import { indexZip } from '@relic/format/zip-index';
import { drawPublishImage } from './publish-cover-image.ts';

/** The reviewed file, or the reviewed default entry of an expanded ZIP. */
export interface CoverPreviewSource {
  readonly name: string;
  readonly mimetype: string;
  readonly size: number;
  /** Refuses an oversized entry before reading or decompressing it. */
  read(maxBytes: number): Promise<Blob | undefined>;
}

/** The immutable raster shown to the publisher and sent if they approve it. */
export interface CoverPreview {
  readonly kind: CoverKind;
  readonly type: CoverType;
  readonly blob: Blob;
}

export type CoverPreviewResult =
  | { readonly status: 'ready'; readonly preview: CoverPreview }
  | { readonly status: 'unsupported'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export type CoverUploadResult =
  | { readonly status: 'uploaded' }
  | { readonly status: 'refused' | 'unconfirmed'; readonly reason: string };

// A cover is optional; decline large inputs before reading or expanding them.
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_INFLATED_PNG_BYTES = COVER_HEIGHT * (1 + COVER_WIDTH * 4) + 1;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function unsupported(reason: string): CoverPreviewResult {
  return { status: 'unsupported', reason };
}

function canvas(): HTMLCanvasElement {
  const element = document.createElement('canvas');
  element.width = COVER_WIDTH;
  element.height = COVER_HEIGHT;
  return element;
}

function context(element: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = element.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable in this browser.');
  return ctx;
}

/** Draw inert content only. Text is painted, never inserted as HTML. */
function drawLines(
  target: HTMLCanvasElement,
  lines: readonly string[],
  kind: 'markdown' | 'code' | 'archive'
): void {
  const ctx = context(target);
  ctx.fillStyle = '#f1f2f0';
  ctx.fillRect(0, 0, COVER_WIDTH, COVER_HEIGHT);
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#16191a';
  ctx.font = kind === 'markdown' ? '28px Georgia, serif' : '26px monospace';
  const lineHeight = kind === 'markdown' ? 42 : 38;
  let y = 54;
  for (const line of lines) {
    if (y + lineHeight > COVER_HEIGHT - 24) break;
    // Do not allow control or bidirectional override characters to disguise
    // which text appears in the public image.
    const safe = Array.from(line.replace(/\t/g, '    '))
      .filter((char) => {
        const code = char.codePointAt(0) ?? 0;
        return !(
          code <= 0x1f ||
          (code >= 0x7f && code <= 0x9f) ||
          code === 0x61c ||
          code === 0x200e ||
          code === 0x200f ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
        );
      })
      .join('')
      .slice(0, 500);
    ctx.fillText(safe, 46, y, COVER_WIDTH - 92);
    y += lineHeight;
  }
}

function isZip(head: Uint8Array): boolean {
  return (
    head.length >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    ((head[2] === 3 && head[3] === 4) || (head[2] === 5 && head[3] === 6))
  );
}

/** Indexes names only. Entries are never extracted for a raw archive cover. */
async function zipListing(blob: Blob): Promise<readonly string[] | undefined> {
  const result = await indexZip(
    {
      size: blob.size,
      async read(start, end) {
        return new Uint8Array(await blob.slice(start, end).arrayBuffer());
      },
    },
    {
      maxArchiveBytes: MAX_SOURCE_BYTES,
      maxEntries: 10_000,
      maxEntryBytes: 0xffffffff,
      maxTotalBytes: Number.MAX_SAFE_INTEGER,
    }
  );
  if (!result.ok) return undefined;
  const entries = [...result.index.entries.values()];
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has('content.otio') && names.has('version.txt')) return undefined;
  return entries
    .slice(0, 14)
    .map((entry) =>
      entry.kind === 'directory' ? `${entry.name}/` : entry.name
    );
}

/** Detect structured private-by-default formats even when renamed as text. */
function restrictedJson(text: string): boolean {
  if (!text.trimStart().startsWith('{')) return false;
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return false;
    const object = value as Record<string, unknown>;
    return (
      (typeof object['nbformat'] === 'number' &&
        Array.isArray(object['cells'])) ||
      typeof object['OTIO_SCHEMA'] === 'string'
    );
  } catch {
    // A damaged notebook still must not become a public text excerpt.
    return (
      (/"nbformat"\s*:/.test(text) && /"cells"\s*:/.test(text)) ||
      /"OTIO_SCHEMA"\s*:/.test(text)
    );
  }
}

/**
 * Preview a public cover locally. The caller renders the returned Blob, never
 * the source. Unsupported and failed previews use the service's generic card.
 */
export async function generateCoverPreview(
  source: CoverPreviewSource
): Promise<CoverPreviewResult> {
  if (!Number.isSafeInteger(source.size) || source.size < 0)
    return { status: 'failed', reason: 'The source size is invalid.' };
  if (source.size === 0)
    return unsupported('An empty file has no cover preview.');
  if (source.size > MAX_SOURCE_BYTES)
    return unsupported('This file is too large for a browser cover preview.');

  try {
    const blob = await source.read(MAX_SOURCE_BYTES);
    if (!blob)
      return unsupported('This file is too large for a browser cover preview.');
    if (blob.size !== source.size)
      throw new Error('The preview source returned an incomplete file.');

    const head = new Uint8Array(
      await blob.slice(0, Math.min(blob.size, 1024 * 1024)).arrayBuffer()
    );
    const name = source.name.toLowerCase();
    const detected = deriveRendererClass(head, source.name);
    const sniffed = sniffContentClass(head);
    if (
      /\.(?:html?|xhtml|jsx|tsx|svg|ipynb|otio|otioz|otiod)$/i.test(name) ||
      detected === 'html' ||
      detected === 'jsx' ||
      detected === 'notebook' ||
      detected === 'otio' ||
      detected === 'model' ||
      sniffed === 'html' ||
      isRawOtio(head) ||
      modelFormatFromFilename(name) !== undefined ||
      modelFormatFromMime(source.mimetype) !== undefined ||
      sniffModelFormat(head, blob.size) !== undefined
    ) {
      return unsupported('This format uses the generic public card.');
    }

    const output = canvas();
    let kind: CoverKind;
    const imageFormat =
      imageFormatOf(head) ??
      (head[0] === 0x42 && head[1] === 0x4d ? 'bmp' : undefined);
    if (imageFormat !== undefined) {
      // The image helper has no heavyweight decoder dependency.
      if (
        !(await drawPublishImage(
          blob,
          head,
          imageFormat,
          output,
          MAX_IMAGE_PIXELS
        ))
      )
        return unsupported(
          'This image cannot be safely previewed in this browser.'
        );
      kind = 'image';
    } else if (sniffed === 'pdf') {
      // PDF.js is split out because most cover sources never need the worker.
      const { drawPublishPdf } = await import('./publish-cover-pdf.ts');
      await drawPublishPdf(blob, output);
      kind = 'pdf';
    } else if (isZip(head)) {
      const lines = await zipListing(blob);
      if (!lines)
        return unsupported('This archive uses the generic public card.');
      drawLines(output, lines, 'archive');
      kind = 'archive';
    } else if (detected === 'media' || sniffed === 'media') {
      // Mediabunny is split out because most cover sources are not media.
      const { drawPublishMedia } = await import('./publish-cover-media.ts');
      const mediaKind = await drawPublishMedia(blob, output, MAX_IMAGE_PIXELS);
      if (!mediaKind)
        return unsupported('This media codec has no browser cover preview.');
      kind = mediaKind;
    } else if (detected === 'markdown' || detected === 'code') {
      if (blob.size > MAX_TEXT_BYTES)
        return unsupported(
          'This text is too large for a browser cover preview.'
        );
      const text = await blob.text();
      if (
        restrictedJson(text) ||
        sniffModelFormat(new TextEncoder().encode(text)) !== undefined
      )
        return unsupported('This format uses the generic public card.');
      if (!text.trim()) return unsupported('This file has no text to preview.');
      kind = detected;
      drawLines(output, text.split(/\r\n|\r|\n/, 16), kind);
    } else {
      return unsupported('This format uses the generic public card.');
    }

    const raster = await encodeRaster(output);
    if (!raster)
      throw new Error('The preview could not fit the cover size limit.');
    const type = raster.type;
    if (type !== 'image/png' && type !== 'image/jpeg')
      throw new Error('Unexpected cover type.');
    const preview = Object.freeze({ kind, type, blob: raster });
    return { status: 'ready', preview };
  } catch {
    return {
      status: 'failed',
      reason: 'The cover preview could not be created.',
    };
  }
}

function toBlob(
  target: HTMLCanvasElement,
  type: CoverType,
  quality?: number
): Promise<Blob | null> {
  const { promise, resolve } = Promise.withResolvers<Blob | null>();
  target.toBlob(resolve, type, quality);
  return promise;
}

/** Remove metadata chunks before showing the exact raster that may be uploaded. */
function normalizePng(bytes: Uint8Array): Uint8Array | undefined {
  if (
    bytes.length < 8 ||
    PNG_SIGNATURE.some((value, index) => bytes[index] !== value)
  )
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  let finished = false;
  while (at + 12 <= bytes.length) {
    const size = view.getUint32(at);
    const end = at + size + 12;
    if (end > bytes.length) return undefined;
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IHDR' || type === 'IDAT' || type === 'IEND')
      chunks.push(bytes.subarray(at, end));
    at = end;
    if (type === 'IEND') {
      finished = true;
      break;
    }
  }
  if (!finished || at !== bytes.length) return undefined;
  return joinChunks(chunks);
}

function normalizeJpeg(bytes: Uint8Array): Uint8Array | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) return undefined;
    const marker = bytes[at++]!;
    if (marker === 0xda) {
      chunks.push(bytes.subarray(at - 2));
      return joinChunks(chunks);
    }
    if (at + 2 > bytes.length) return undefined;
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length) return undefined;
    if (!((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe))
      chunks.push(bytes.subarray(at - 2, at + length));
    at += length;
  }
  return undefined;
}

function joinChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function validatePng(bytes: Uint8Array): Promise<boolean> {
  if (typeof DecompressionStream === 'undefined') return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Uint8Array[] = [];
  for (let at = 8; at + 12 <= bytes.length; ) {
    const size = view.getUint32(at);
    if (at + 12 + size > bytes.length) return false;
    if (view.getUint32(at + 4) === 0x49444154)
      chunks.push(bytes.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  try {
    const compressed = joinChunks(chunks);
    const stream = new Blob([compressed as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    const inflated: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.byteLength;
        if (length > MAX_INFLATED_PNG_BYTES) {
          await reader.cancel();
          return false;
        }
        inflated.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const decoded = joinChunks(inflated);
    return validateCoverRaster(bytes, (_data, max) => {
      if (decoded.length > max)
        throw new RangeError('PNG exceeded its pixel bound');
      return decoded;
    }).ok;
  } catch {
    return false;
  }
}

async function encodeRaster(
  target: HTMLCanvasElement
): Promise<Blob | undefined> {
  const candidates: ReadonlyArray<{ type: CoverType; quality?: number }> = [
    { type: 'image/png' },
    { type: 'image/jpeg', quality: 0.85 },
    { type: 'image/jpeg', quality: 0.7 },
    { type: 'image/jpeg', quality: 0.55 },
    { type: 'image/jpeg', quality: 0.4 },
  ];
  for (const candidate of candidates) {
    const raw = await toBlob(target, candidate.type, candidate.quality);
    if (!raw || raw.type !== candidate.type) continue;
    const input = new Uint8Array(await raw.arrayBuffer());
    const bytes =
      candidate.type === 'image/png'
        ? normalizePng(input)
        : normalizeJpeg(input);
    if (!bytes || bytes.length > COVER_CAP_BYTES) continue;
    const valid =
      candidate.type === 'image/png'
        ? await validatePng(bytes)
        : validateCoverRaster(bytes, () => {
            throw new Error('Unexpected PNG');
          }).ok;
    if (valid) return new Blob([bytes as BlobPart], { type: candidate.type });
  }
  return undefined;
}

function base64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  // A multiple of three prevents padding between separately encoded pieces.
  const chunkSize = 24_576;
  for (let at = 0; at < bytes.length; at += chunkSize) {
    pieces.push(
      btoa(String.fromCharCode(...bytes.subarray(at, at + chunkSize)))
    );
  }
  return pieces.join('');
}

/** Send the approved, immutable preview after the ciphertext PUT succeeds. */
export async function uploadPublishCover(
  serviceOrigin: string,
  relicId: string,
  publishToken: string,
  preview: CoverPreview,
  fetcher: (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => Promise<Response> = globalThis.fetch
): Promise<CoverUploadResult> {
  try {
    const bytes = new Uint8Array(await preview.blob.arrayBuffer());
    if (
      !bytes.length ||
      bytes.length > COVER_CAP_BYTES ||
      preview.blob.type !== preview.type
    )
      return { status: 'refused', reason: 'The approved cover is invalid.' };
    const hash = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)
      ),
      (byte) => byte.toString(16).padStart(2, '0')
    ).join('');
    const response = await fetcher(
      `${serviceOrigin.replace(/\/+$/, '')}/api/relics/${encodeURIComponent(relicId)}/cover`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          publish_token: publishToken,
          version: 1,
          kind: preview.kind,
          type: preview.type,
          data: base64(bytes),
        }),
      }
    );
    if (!response.ok) {
      return response.status >= 400 && response.status < 500
        ? { status: 'refused', reason: 'The service refused the cover.' }
        : {
            status: 'unconfirmed',
            reason: 'The service did not confirm the cover.',
          };
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return {
        status: 'unconfirmed',
        reason: 'The service did not confirm the cover.',
      };
    const result = body as Record<string, unknown>;
    if (
      result['relic_id'] !== relicId ||
      result['version'] !== 1 ||
      result['kind'] !== preview.kind ||
      result['type'] !== preview.type ||
      result['bytes'] !== bytes.length ||
      result['sha256'] !== hash
    ) {
      return {
        status: 'unconfirmed',
        reason: 'The service did not confirm the approved cover.',
      };
    }
    return { status: 'uploaded' };
  } catch {
    return {
      status: 'unconfirmed',
      reason: 'The cover upload could not be confirmed.',
    };
  }
}
