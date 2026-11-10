/**
 * Page entry for the offline program renderer. Loaded from the virtual origin.
 * Exposes window.__relicProgram.render(request); see protocol.ts.
 *
 * The page's only fetches are the media URLs in the request. Each finished MP4
 * is streamed to the host in order as `${seq}:${base64}` chunks, after
 * finalization and only on success.
 */
import { readOtioDocument } from '@relic/format';
import { ProgramRenderFailure, failure } from './failure.ts';
import { ProgramMedia } from './media.ts';
import { renderProgramTimeline } from './render.ts';
import {
  PROGRAM_CHUNK_BYTES,
  PROGRAM_MAX_AREA,
  PROGRAM_MAX_BYTES,
  PROGRAM_MAX_DIMENSION,
  PROGRAM_PAGE_PROTOCOL,
  type ProgramRenderReason,
  type ProgramRenderRequest,
  type ProgramRenderResult,
} from './protocol.ts';

let busy = false;

function validateRequest(request: ProgramRenderRequest): void {
  const dimensions = [request.width, request.height];
  const ok =
    request.protocol === PROGRAM_PAGE_PROTOCOL &&
    Number.isSafeInteger(request.timeline_index) &&
    request.timeline_index >= 0 &&
    typeof request.content === 'string' &&
    Array.isArray(request.media) &&
    dimensions.every(
      (value) =>
        Number.isSafeInteger(value) &&
        value >= 2 &&
        value <= PROGRAM_MAX_DIMENSION &&
        value % 2 === 0
    ) &&
    request.width * request.height <= PROGRAM_MAX_AREA &&
    Number.isSafeInteger(request.max_bytes) &&
    request.max_bytes > 0 &&
    request.max_bytes <= PROGRAM_MAX_BYTES;
  if (!ok) {
    throw failure(
      'render-failed',
      `Invalid render request: dimensions ${request.width}x${request.height} (even, 2..${PROGRAM_MAX_DIMENSION}, area <= ${PROGRAM_MAX_AREA}), max_bytes ${request.max_bytes} (1..${PROGRAM_MAX_BYTES}), timeline_index ${request.timeline_index}`
    );
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function reasonsOf(error: unknown): ProgramRenderReason[] {
  if (error instanceof ProgramRenderFailure) return [...error.reasons];
  const message = error instanceof Error ? error.message : String(error);
  return [{ code: 'render-failed', message }];
}

async function render(
  request: ProgramRenderRequest
): Promise<ProgramRenderResult> {
  if (busy) {
    return {
      ok: false,
      reasons: [
        { code: 'render-failed', message: 'A render is already running' },
      ],
    };
  }
  busy = true;
  let media: ProgramMedia | null = null;
  try {
    validateRequest(request);
    if (request.force_encoder_absent) {
      throw failure(
        'encoder-unavailable',
        'Encoder support was disabled for this request'
      );
    }
    if (typeof window.__relicProgramChunk !== 'function') {
      throw failure('render-failed', 'Host chunk binding is missing');
    }
    const mediaIndex = Object.fromEntries(
      request.media.map((entry) => [entry.key, entry] as const)
    );
    const doc = readOtioDocument(request.content, { mediaIndex });
    const timelineId = doc.timeline_ids[request.timeline_index];
    if (timelineId === undefined) {
      throw failure(
        'invalid-timing',
        `Timeline index ${request.timeline_index} is not in the document`
      );
    }
    media = new ProgramMedia(
      new Set(request.media.map((entry) => entry.bundle_path))
    );
    const rendered = await renderProgramTimeline({
      document: doc,
      timelineId,
      width: request.width,
      height: request.height,
      maxBytes: request.max_bytes,
      media,
      createCanvas: () => document.createElement('canvas'),
    });
    const { bytes } = rendered;
    let seq = 0;
    for (
      let offset = 0;
      offset < bytes.byteLength;
      offset += PROGRAM_CHUNK_BYTES
    ) {
      const chunk = toBase64(
        bytes.subarray(offset, offset + PROGRAM_CHUNK_BYTES)
      );
      window.__relicProgramChunk?.(`${seq}:${chunk}`);
      seq += 1;
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return {
      ok: true,
      document_sha256: doc.document_sha256,
      timeline_id: timelineId,
      program: rendered.program,
      byte_length: bytes.byteLength,
      sha256: toHex(digest),
    };
  } catch (error) {
    return { ok: false, reasons: reasonsOf(error) };
  } finally {
    media?.dispose();
    busy = false;
  }
}

window.__relicProgram = { protocol: PROGRAM_PAGE_PROTOCOL, render };
