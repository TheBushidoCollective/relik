import { describe, expect, test } from 'bun:test';
import { deflateSync } from 'node:zlib';
import {
  COVER_CAP_BYTES,
  COVER_HEIGHT,
  COVER_WIDTH,
  crc32,
} from '@relic/format/cover';
import {
  executeEncodeLadder,
  normalizeJpeg,
  normalizePng,
  validateRaster,
} from '../src/cover/raster.ts';

const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  view.setUint32(0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const typeAndData = chunk.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(typeAndData));
  return chunk;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((acc, a) => acc + a.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const a of arrays) {
    out.set(a, pos);
    pos += a.length;
  }
  return out;
}

function makeIhdr(
  width = COVER_WIDTH,
  height = COVER_HEIGHT,
  bitDepth = 8,
  colorType = 2
): Uint8Array {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = 0; // interlace
  return makeChunk('IHDR', data);
}

function makeValidPng(colorType: 2 | 6 = 2): Uint8Array {
  const bpp = colorType === 2 ? 3 : 4;
  const rawPixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * bpp));
  const idat = makeChunk('IDAT', deflateSync(rawPixels));
  const iend = makeChunk('IEND', new Uint8Array(0));
  return concat(
    PNG_SIGNATURE,
    makeIhdr(COVER_WIDTH, COVER_HEIGHT, 8, colorType),
    idat,
    iend
  );
}

function makeOversizedPng(): Uint8Array {
  const bpp = 3;
  const scanlineLen = 1 + COVER_WIDTH * bpp;
  const rawPixels = new Uint8Array(COVER_HEIGHT * scanlineLen);
  for (let y = 0; y < COVER_HEIGHT; y++) {
    const start = y * scanlineLen;
    rawPixels[start] = 0;
    crypto.getRandomValues(rawPixels.subarray(start + 1, start + scanlineLen));
  }
  const bigCompressed = deflateSync(rawPixels);
  return concat(
    PNG_SIGNATURE,
    makeIhdr(COVER_WIDTH, COVER_HEIGHT, 8, 2),
    makeChunk('IDAT', bigCompressed),
    makeChunk('IEND', new Uint8Array(0))
  );
}

function makeValidJpeg(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00, // APP0 (JFIF)
    0xff,
    0xdb,
    0x00,
    0x43,
    0x00,
    ...new Array(64).fill(1), // DQT
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x02,
    0x76,
    0x04,
    0xb0,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00, // SOF0 (630x1200, 3 components)
    0xff,
    0xc4,
    0x00,
    0x1f,
    0x00,
    0x00,
    0x01,
    0x05,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x01,
    0x02,
    0x03,
    0x04,
    0x05,
    0x06,
    0x07,
    0x08,
    0x09,
    0x0a,
    0x0b, // DHT
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x00,
    0x03,
    0x00,
    0x00,
    0x3f,
    0x00, // SOS
    0x12,
    0x34,
    0xff,
    0x00,
    0x56, // entropy with FF00 stuffing
    0xff,
    0xd9, // EOI
  ]);
}

describe('cover-raster', () => {
  test('normalizePng preserves valid PNG structure', () => {
    const png = makeValidPng();
    const normalized = normalizePng(png);
    const val = validateRaster(normalized);
    expect(val.ok).toBe(true);
    if (val.ok) {
      expect(val.type).toBe('image/png');
    }
  });

  test('mutation proof: skip normalizePng chunk stripping and a raster test must fail', () => {
    const validPng = makeValidPng();
    const textChunk = makeChunk(
      'tEXt',
      new TextEncoder().encode('Author=Relik')
    );
    // Insert tEXt chunk between IHDR and IDAT
    const sigAndIhdr = validPng.subarray(0, 8 + 25);
    const rest = validPng.subarray(8 + 25);
    const unnormalized = concat(sigAndIhdr, textChunk, rest);

    // Unnormalized PNG fails chunk check in validateRaster
    const preValidation = validateRaster(unnormalized);
    expect(preValidation.ok).toBe(false);
    if (!preValidation.ok) {
      expect(preValidation.failure).toBe('chunk');
    }

    // normalizePng strips the chunk, allowing validation to pass
    const normalized = normalizePng(unnormalized);
    const postValidation = validateRaster(normalized);
    expect(postValidation.ok).toBe(true);
    expect(normalized.length).toBeLessThan(unnormalized.length);
  });

  test('normalizePng strips trailing data after IEND', () => {
    const validPng = makeValidPng();
    const trailing = new Uint8Array([1, 2, 3, 4, 5]);
    const withTrailing = concat(validPng, trailing);

    expect(validateRaster(withTrailing).ok).toBe(false);
    const normalized = normalizePng(withTrailing);
    expect(validateRaster(normalized).ok).toBe(true);
    expect(normalized.length).toBe(validPng.length);
  });

  test('normalizeJpeg preserves valid JPEG and strips APP2/COM markers', () => {
    const validJpeg = makeValidJpeg();
    const val = validateRaster(validJpeg);
    expect(val.ok).toBe(true);

    // Insert an APP2 marker before DQT
    const app2 = new Uint8Array([
      0xff, 0xe2, 0x00, 0x06, 0x49, 0x43, 0x43, 0x00,
    ]);
    // Insert COM marker
    const com = new Uint8Array([
      0xff, 0xfe, 0x00, 0x06, 0x54, 0x65, 0x73, 0x74,
    ]);

    const withApp2AndCom = concat(
      validJpeg.subarray(0, 20), // SOI (2) + APP0 (18)
      app2,
      com,
      validJpeg.subarray(20) // rest starting at DQT
    );

    // Before normalization, APP2 causes rejection
    const preVal = validateRaster(withApp2AndCom);
    expect(preVal.ok).toBe(false);
    if (!preVal.ok) {
      expect(preVal.failure).toBe('chunk');
    }

    // After normalizeJpeg, APP2 and COM are stripped
    const normalized = normalizeJpeg(withApp2AndCom);
    const postVal = validateRaster(normalized);
    expect(postVal.ok).toBe(true);
  });

  test('executeEncodeLadder uses PNG when under budget', async () => {
    const validPng = makeValidPng();
    const calls: string[] = [];

    const outcome = await executeEncodeLadder(async (opts) => {
      calls.push(`${opts.format}${opts.quality ? `_q${opts.quality}` : ''}`);
      return validPng;
    }, 'markdown');

    expect(outcome.status).toBe('rendered');
    if (outcome.status === 'rendered') {
      expect(outcome.type).toBe('image/png');
      expect(outcome.kind).toBe('markdown');
    }
    expect(calls).toEqual(['png']);
  });

  test('executeEncodeLadder falls back to JPEG q85 when PNG exceeds budget', async () => {
    const oversizedPng = makeOversizedPng();
    expect(oversizedPng.length).toBeGreaterThan(COVER_CAP_BYTES);

    const validJpeg = makeValidJpeg();
    const calls: string[] = [];

    const outcome = await executeEncodeLadder(async (opts) => {
      calls.push(`${opts.format}${opts.quality ? `_q${opts.quality}` : ''}`);
      if (opts.format === 'png') return oversizedPng;
      return validJpeg;
    }, 'code');

    expect(outcome.status).toBe('rendered');
    if (outcome.status === 'rendered') {
      expect(outcome.type).toBe('image/jpeg');
      expect(outcome.kind).toBe('code');
    }
    expect(calls).toEqual(['png', 'jpeg_q85']);
  });

  test('executeEncodeLadder falls back to JPEG q70 when JPEG q85 exceeds budget', async () => {
    const oversizedPng = makeOversizedPng();
    const oversizedJpeg = new Uint8Array(COVER_CAP_BYTES + 50);
    const validJpeg = makeValidJpeg();

    const calls: string[] = [];
    const outcome = await executeEncodeLadder(async (opts) => {
      calls.push(`${opts.format}${opts.quality ? `_q${opts.quality}` : ''}`);
      if (opts.format === 'png') return oversizedPng;
      if (opts.quality === 85) return oversizedJpeg;
      return validJpeg;
    }, 'html');

    expect(outcome.status).toBe('rendered');
    if (outcome.status === 'rendered') {
      expect(outcome.type).toBe('image/jpeg');
      expect(outcome.kind).toBe('html');
    }
    expect(calls).toEqual(['png', 'jpeg_q85', 'jpeg_q70']);
  });

  test('executeEncodeLadder skips with over_size_budget when all captures exceed budget', async () => {
    const oversizedPng = makeOversizedPng();
    const oversizedJpeg = new Uint8Array(COVER_CAP_BYTES + 100);

    const calls: string[] = [];
    const outcome = await executeEncodeLadder(async (opts) => {
      calls.push(`${opts.format}${opts.quality ? `_q${opts.quality}` : ''}`);
      if (opts.format === 'png') return oversizedPng;
      return oversizedJpeg;
    }, 'pdf');

    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('over_size_budget');
    }
    expect(calls).toEqual(['png', 'jpeg_q85', 'jpeg_q70']);
  });

  test('executeEncodeLadder skips with render_failed on invalid raster output', async () => {
    const corruptBytes = new Uint8Array([1, 2, 3, 4]);
    const outcome = await executeEncodeLadder(
      async () => corruptBytes,
      'markdown'
    );

    expect(outcome.status).toBe('skipped');
    if (outcome.status === 'skipped') {
      expect(outcome.reason).toBe('render_failed');
    }
  });
});
