import type { RendererClass } from './renderer-class.ts';

export const COVER_WIDTH = 1200;
export const COVER_HEIGHT = 630;
export const COVER_CSS_WIDTH = 600;
export const COVER_CSS_HEIGHT = 315;
export const COVER_DEVICE_SCALE = 2;
export const COVER_CAP_BYTES = 524_288;
export const COVER_PAGE_PROTOCOL = 1;
export const COVER_INPUT_PART_BYTES = 16_777_216;

export const COVER_KINDS = [
  'markdown',
  'code',
  'html',
  'jsx',
  'image',
  'pdf',
  'video',
  'audio-artwork',
  'audio-waveform',
  'archive',
] as const;
export type CoverKind = (typeof COVER_KINDS)[number];

export function isCoverKind(v: unknown): v is CoverKind {
  return (
    typeof v === 'string' && (COVER_KINDS as readonly string[]).includes(v)
  );
}

export const COVER_TYPES = ['image/png', 'image/jpeg'] as const;
export type CoverType = (typeof COVER_TYPES)[number];

export function coverExtension(t: CoverType): 'png' | 'jpg' {
  if (t === 'image/png') return 'png';
  if (t === 'image/jpeg') return 'jpg';
  throw new Error(`Unknown cover type: ${String(t)}`);
}

export interface ArchiveEntry {
  readonly path: string;
  readonly size: number | null;
  readonly directory: boolean;
}

export interface ArchiveListing {
  readonly format: 'zip' | 'tar' | 'tar.gz' | 'gzip';
  readonly entries: readonly ArchiveEntry[] /* first 200, archive order */;
  readonly totalEntries:
    | number
    | null /* null when the walk cap stopped counting */;
  readonly totalBytes: number | null;
}

export interface CoverRenderRequest {
  readonly protocol: 1;
  readonly kind: CoverKind;
  readonly input?:
    | {
        readonly bytes: number;
        readonly parts: number;
        readonly mimetype: string;
      }
    | undefined;
  readonly dialect?: 'jsx' | 'tsx' | undefined;
  readonly listing?: ArchiveListing | undefined;
}

export type CoverRenderResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'decode_failed' | 'parse_failed' | 'timeout' | 'empty';
      readonly detail: string;
    };

export interface CoverSource {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mimetype: string;
  readonly rendererClass: RendererClass;
}

export type CoverSkipReason =
  | 'browser_disabled'
  | 'browser_not_found'
  | 'browser_failed'
  | 'ffmpeg_not_found'
  | 'no_cover_for_class'
  | 'archive_format_unlisted'
  | 'empty_content'
  | 'render_failed'
  | 'render_timeout'
  | 'over_size_budget'
  | 'over_render_ceiling'
  | 'service_unsupported'
  | 'service_refused'
  | 'upload_failed';

export type CoverOutcome =
  | {
      readonly status: 'rendered';
      readonly kind: CoverKind;
      readonly type: CoverType;
      readonly bytes: Uint8Array;
    }
  | {
      readonly status: 'skipped';
      readonly reason: CoverSkipReason;
      readonly detail: string;
    };

export type CoverReport =
  | {
      readonly status: 'uploaded';
      readonly kind: CoverKind;
      readonly type: CoverType;
      readonly url: string;
      readonly bytes: number;
    }
  | { readonly status: 'declined' }
  | {
      readonly status: 'skipped';
      readonly reason: CoverSkipReason;
      readonly detail: string;
    };

export type CoverValidationFailure =
  | 'size'
  | 'signature'
  | 'dimensions'
  | 'structure'
  | 'chunk'
  | 'crc'
  | 'pixel_data'
  | 'trailing_data';

export type CoverValidation =
  | { readonly ok: true; readonly type: CoverType }
  | {
      readonly ok: false;
      readonly failure: CoverValidationFailure;
      readonly detail: string;
    };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  CRC_TABLE[n] = c;
}

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    const tableVal = CRC_TABLE[(c ^ byte) & 0xff] ?? 0;
    c = tableVal ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function validatePng(
  bytes: Uint8Array,
  inflate: (data: Uint8Array, maxOutputLength: number) => Uint8Array
): CoverValidation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let ihdrSeen = false;
  let iendSeen = false;
  let colorType = 0;
  let bpp = 0;
  const idatChunks: Uint8Array[] = [];
  let totalIdatBytes = 0;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      return { ok: false, failure: 'crc', detail: 'Truncated chunk header' };
    }

    const chunkLength = view.getUint32(offset);
    const type0 = view.getUint8(offset + 4);
    const type1 = view.getUint8(offset + 5);
    const type2 = view.getUint8(offset + 6);
    const type3 = view.getUint8(offset + 7);
    const chunkType = String.fromCharCode(type0, type1, type2, type3);

    if (offset + 12 + chunkLength > bytes.length) {
      return {
        ok: false,
        failure: 'crc',
        detail: `Chunk ${chunkType} length ${chunkLength} exceeds file bounds`,
      };
    }

    const chunkTypeAndData = bytes.subarray(
      offset + 4,
      offset + 8 + chunkLength
    );
    const expectedCrc = view.getUint32(offset + 8 + chunkLength);
    const actualCrc = crc32(chunkTypeAndData);
    if (actualCrc !== expectedCrc) {
      return {
        ok: false,
        failure: 'crc',
        detail: `CRC mismatch for chunk ${chunkType}: expected ${expectedCrc}, got ${actualCrc}`,
      };
    }

    if (!ihdrSeen) {
      if (chunkType !== 'IHDR') {
        return {
          ok: false,
          failure: 'chunk',
          detail: `First chunk must be IHDR, got ${chunkType}`,
        };
      }
      ihdrSeen = true;
      if (chunkLength !== 13) {
        return {
          ok: false,
          failure: 'structure',
          detail: `IHDR length must be 13, got ${chunkLength}`,
        };
      }

      const width = view.getUint32(offset + 8);
      const height = view.getUint32(offset + 12);
      const bitDepth = view.getUint8(offset + 16);
      colorType = view.getUint8(offset + 17);
      const compression = view.getUint8(offset + 18);
      const filter = view.getUint8(offset + 19);
      const interlace = view.getUint8(offset + 20);

      if (width !== COVER_WIDTH || height !== COVER_HEIGHT) {
        return {
          ok: false,
          failure: 'dimensions',
          detail: `Expected ${COVER_WIDTH}x${COVER_HEIGHT} dimensions, got ${width}x${height}`,
        };
      }

      if (bitDepth !== 8) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Unsupported bit depth ${bitDepth}, expected 8`,
        };
      }

      if (colorType !== 2 && colorType !== 6) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Unsupported color type ${colorType}, expected 2 (RGB) or 6 (RGBA)`,
        };
      }

      if (compression !== 0) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Unsupported compression method ${compression}, expected 0`,
        };
      }

      if (filter !== 0) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Unsupported filter method ${filter}, expected 0`,
        };
      }

      if (interlace !== 0) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Interlaced PNG is not allowed',
        };
      }

      bpp = colorType === 2 ? 3 : 4;
      offset += 12 + chunkLength;
      continue;
    }

    if (chunkType === 'IDAT') {
      if (iendSeen) {
        return {
          ok: false,
          failure: 'chunk',
          detail: 'IDAT chunk cannot appear after IEND',
        };
      }
      idatChunks.push(bytes.subarray(offset + 8, offset + 8 + chunkLength));
      totalIdatBytes += chunkLength;
      offset += 12 + chunkLength;
      continue;
    }

    if (chunkType === 'IEND') {
      if (idatChunks.length === 0) {
        return {
          ok: false,
          failure: 'chunk',
          detail: 'Missing IDAT chunk before IEND',
        };
      }
      if (chunkLength !== 0) {
        return {
          ok: false,
          failure: 'chunk',
          detail: `IEND length must be 0, got ${chunkLength}`,
        };
      }
      iendSeen = true;
      offset += 12 + chunkLength;
      if (offset < bytes.length) {
        return {
          ok: false,
          failure: 'trailing_data',
          detail: `Found ${bytes.length - offset} trailing bytes after IEND`,
        };
      }
      break;
    }

    return {
      ok: false,
      failure: 'chunk',
      detail: `Disallowed PNG chunk type: ${chunkType}`,
    };
  }

  if (!iendSeen) {
    return {
      ok: false,
      failure: 'structure',
      detail: 'Missing IEND chunk',
    };
  }

  const idatPayload = new Uint8Array(totalIdatBytes);
  let cursor = 0;
  for (const chunk of idatChunks) {
    idatPayload.set(chunk, cursor);
    cursor += chunk.length;
  }

  const expectedLength = COVER_HEIGHT * (1 + COVER_WIDTH * bpp);
  let inflated: Uint8Array;
  try {
    inflated = inflate(idatPayload, expectedLength + 1);
  } catch (err) {
    return {
      ok: false,
      failure: 'pixel_data',
      detail:
        err instanceof Error ? err.message : 'Failed to inflate IDAT stream',
    };
  }

  if (inflated.length !== expectedLength) {
    return {
      ok: false,
      failure: 'pixel_data',
      detail: `Inflated IDAT length ${inflated.length} does not match expected ${expectedLength}`,
    };
  }

  const rowLength = 1 + COVER_WIDTH * bpp;
  for (let row = 0; row < COVER_HEIGHT; row++) {
    const filterByte = inflated[row * rowLength] ?? 255;
    if (filterByte > 4) {
      return {
        ok: false,
        failure: 'pixel_data',
        detail: `Invalid filter byte ${filterByte} on row ${row}`,
      };
    }
  }

  return { ok: true, type: 'image/png' };
}

function validateJpeg(bytes: Uint8Array): CoverValidation {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; // after SOI
  let app0Count = 0;
  let sofCount = 0;
  let seenSos = false;

  while (!seenSos) {
    if (offset >= bytes.length) {
      return {
        ok: false,
        failure: 'structure',
        detail: 'Unexpected end of JPEG before SOS',
      };
    }
    const leadByte = view.getUint8(offset);
    if (leadByte !== 0xff) {
      return {
        ok: false,
        failure: 'structure',
        detail: `Expected marker 0xFF at offset ${offset}, got 0x${leadByte.toString(16)}`,
      };
    }
    while (offset < bytes.length && view.getUint8(offset) === 0xff) {
      offset++;
    }
    if (offset >= bytes.length) {
      return {
        ok: false,
        failure: 'structure',
        detail: 'Unexpected end of JPEG marker',
      };
    }
    const marker = view.getUint8(offset++);

    if (marker === 0xd9) {
      return { ok: false, failure: 'structure', detail: 'EOI before SOS' };
    }

    if (marker === 0xe0) {
      if (app0Count > 0) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Duplicate APP0 marker',
        };
      }
      app0Count++;
      if (offset + 2 > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Truncated APP0 marker',
        };
      }
      const len = view.getUint16(offset);
      if (len < 7 || offset + len > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Invalid APP0 length',
        };
      }
      if (
        view.getUint8(offset + 2) !== 0x4a || // 'J'
        view.getUint8(offset + 3) !== 0x46 || // 'F'
        view.getUint8(offset + 4) !== 0x49 || // 'I'
        view.getUint8(offset + 5) !== 0x46 || // 'F'
        view.getUint8(offset + 6) !== 0x00 // '\0'
      ) {
        return { ok: false, failure: 'structure', detail: 'APP0 is not JFIF' };
      }
      offset += len;
      continue;
    }

    if (marker === 0xdb || marker === 0xdd || marker === 0xc4) {
      if (offset + 2 > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Truncated marker 0x${marker.toString(16)}`,
        };
      }
      const len = view.getUint16(offset);
      if (len < 2 || offset + len > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Invalid length for marker 0x${marker.toString(16)}`,
        };
      }
      offset += len;
      continue;
    }

    if (marker === 0xc0 || marker === 0xc2) {
      if (sofCount > 0) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Multiple SOF markers',
        };
      }
      sofCount++;
      if (offset + 2 > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Truncated SOF marker',
        };
      }
      const len = view.getUint16(offset);
      if (len < 8 || offset + len > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Invalid SOF length',
        };
      }
      const precision = view.getUint8(offset + 2);
      const height = view.getUint16(offset + 3);
      const width = view.getUint16(offset + 5);
      const components = view.getUint8(offset + 7);

      if (height !== COVER_HEIGHT || width !== COVER_WIDTH) {
        return {
          ok: false,
          failure: 'dimensions',
          detail: `Expected ${COVER_WIDTH}x${COVER_HEIGHT} dimensions, got ${width}x${height}`,
        };
      }

      if (precision !== 8) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Unsupported JPEG precision ${precision}, expected 8`,
        };
      }

      if (components !== 1 && components !== 3) {
        return {
          ok: false,
          failure: 'structure',
          detail: `Unsupported JPEG components ${components}, expected 1 or 3`,
        };
      }

      offset += len;
      continue;
    }

    if (marker === 0xda) {
      if (sofCount === 0) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'SOS marker before SOF',
        };
      }
      if (offset + 2 > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Truncated SOS marker',
        };
      }
      const len = view.getUint16(offset);
      if (len < 2 || offset + len > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Invalid SOS length',
        };
      }
      offset += len;
      seenSos = true;
      break;
    }

    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      return {
        ok: false,
        failure: 'chunk',
        detail: `Disallowed JPEG marker 0x${marker.toString(16).toUpperCase()}`,
      };
    }

    return {
      ok: false,
      failure: 'chunk',
      detail: `Unexpected JPEG marker 0x${marker.toString(16).toUpperCase()}`,
    };
  }

  let inEntropy = true;

  while (offset < bytes.length) {
    if (inEntropy) {
      const b = bytes[offset++] ?? 0;
      if (b !== 0xff) {
        continue;
      }
      while (offset < bytes.length && (bytes[offset] ?? 0) === 0xff) {
        offset++;
      }
      if (offset >= bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Truncated entropy data before marker',
        };
      }
      const marker = bytes[offset++] ?? 0;
      if (marker === 0x00) {
        continue;
      }
      if (marker >= 0xd0 && marker <= 0xd7) {
        continue;
      }
      if (marker === 0xd9) {
        if (offset < bytes.length) {
          return {
            ok: false,
            failure: 'trailing_data',
            detail: `Found ${bytes.length - offset} trailing bytes after EOI`,
          };
        }
        return { ok: true, type: 'image/jpeg' };
      }
      if (marker === 0xc4) {
        if (offset + 2 > bytes.length) {
          return {
            ok: false,
            failure: 'structure',
            detail: 'Truncated DHT marker',
          };
        }
        const len = view.getUint16(offset);
        if (len < 2 || offset + len > bytes.length) {
          return {
            ok: false,
            failure: 'structure',
            detail: 'Invalid DHT length',
          };
        }
        offset += len;
        inEntropy = false;
        continue;
      }
      if (marker === 0xda) {
        if (offset + 2 > bytes.length) {
          return {
            ok: false,
            failure: 'structure',
            detail: 'Truncated SOS marker',
          };
        }
        const len = view.getUint16(offset);
        if (len < 2 || offset + len > bytes.length) {
          return {
            ok: false,
            failure: 'structure',
            detail: 'Invalid SOS length',
          };
        }
        offset += len;
        inEntropy = true;
        continue;
      }
      if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
        return {
          ok: false,
          failure: 'chunk',
          detail: `Disallowed JPEG marker 0x${marker.toString(16).toUpperCase()} after SOS`,
        };
      }
      return {
        ok: false,
        failure: 'chunk',
        detail: `Disallowed JPEG marker 0x${marker.toString(16).toUpperCase()} in scan data`,
      };
    }

    // Between scans
    if (view.getUint8(offset) !== 0xff) {
      return {
        ok: false,
        failure: 'structure',
        detail: `Expected marker 0xFF at offset ${offset}`,
      };
    }
    while (offset < bytes.length && view.getUint8(offset) === 0xff) {
      offset++;
    }
    if (offset >= bytes.length) {
      return {
        ok: false,
        failure: 'structure',
        detail: 'Unexpected end of JPEG',
      };
    }
    const marker = view.getUint8(offset++);
    if (marker === 0xd9) {
      if (offset < bytes.length) {
        return {
          ok: false,
          failure: 'trailing_data',
          detail: `Found ${bytes.length - offset} trailing bytes after EOI`,
        };
      }
      return { ok: true, type: 'image/jpeg' };
    }
    if (marker === 0xc4) {
      if (offset + 2 > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Truncated DHT marker',
        };
      }
      const len = view.getUint16(offset);
      if (len < 2 || offset + len > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Invalid DHT length',
        };
      }
      offset += len;
      continue;
    }
    if (marker === 0xda) {
      if (offset + 2 > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Truncated SOS marker',
        };
      }
      const len = view.getUint16(offset);
      if (len < 2 || offset + len > bytes.length) {
        return {
          ok: false,
          failure: 'structure',
          detail: 'Invalid SOS length',
        };
      }
      offset += len;
      inEntropy = true;
      continue;
    }
    if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      return {
        ok: false,
        failure: 'chunk',
        detail: `Disallowed JPEG marker 0x${marker.toString(16).toUpperCase()} after SOS`,
      };
    }
    return {
      ok: false,
      failure: 'chunk',
      detail: `Disallowed JPEG marker 0x${marker.toString(16).toUpperCase()} between scans`,
    };
  }

  return {
    ok: false,
    failure: 'structure',
    detail: 'Unexpected end of JPEG before EOI',
  };
}

export function validateCoverRaster(
  bytes: Uint8Array,
  inflate: (data: Uint8Array, maxOutputLength: number) => Uint8Array
): CoverValidation {
  if (bytes.length === 0 || bytes.length > COVER_CAP_BYTES) {
    return {
      ok: false,
      failure: 'size',
      detail:
        bytes.length === 0
          ? 'Cover raster is empty'
          : `Cover raster size ${bytes.length} exceeds cap of ${COVER_CAP_BYTES} bytes`,
    };
  }

  const isPng =
    bytes.length >= 8 &&
    bytes[0] === PNG_SIGNATURE[0] &&
    bytes[1] === PNG_SIGNATURE[1] &&
    bytes[2] === PNG_SIGNATURE[2] &&
    bytes[3] === PNG_SIGNATURE[3] &&
    bytes[4] === PNG_SIGNATURE[4] &&
    bytes[5] === PNG_SIGNATURE[5] &&
    bytes[6] === PNG_SIGNATURE[6] &&
    bytes[7] === PNG_SIGNATURE[7];

  if (isPng) {
    return validatePng(bytes, inflate);
  }

  const isJpeg = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;

  if (isJpeg) {
    return validateJpeg(bytes);
  }

  return {
    ok: false,
    failure: 'signature',
    detail: 'Cover raster signature is neither PNG nor JPEG',
  };
}
