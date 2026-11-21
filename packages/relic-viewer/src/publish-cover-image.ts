import type { ImageFormat } from '@relic/format/notebook';

type PublishImageFormat = ImageFormat | 'bmp';

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

/** Read dimensions from the header before asking a browser decoder to allocate. */
function imageDimensions(
  bytes: Uint8Array,
  format: PublishImageFormat
): Dimensions | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (format === 'png') {
    if (
      bytes.length < 24 ||
      view.getUint32(8) !== 13 ||
      view.getUint32(12) !== 0x49484452
    )
      return undefined;
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (format === 'gif') {
    if (bytes.length < 10) return undefined;
    return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
  }
  if (format === 'bmp') {
    if (bytes.length < 26) return undefined;
    const headerSize = view.getUint32(14, true);
    if (headerSize === 12)
      return {
        width: view.getUint16(18, true),
        height: view.getUint16(20, true),
      };
    if (headerSize < 40) return undefined;
    const width = view.getInt32(18, true);
    const height = view.getInt32(22, true);
    if (width <= 0 || height === -2147483648) return undefined;
    return { width, height: Math.abs(height) };
  }
  if (format === 'webp') {
    if (bytes.length < 30) return undefined;
    let canvas: Dimensions | undefined;
    let at = 12;
    while (at + 8 <= bytes.length) {
      const chunk = String.fromCharCode(...bytes.subarray(at, at + 4));
      const length = view.getUint32(at + 4, true);
      const data = at + 8;
      if (chunk === 'VP8X') {
        if (
          length < 10 ||
          data + 10 > bytes.length ||
          (bytes[data]! & 0x02) !== 0
        )
          return undefined;
        canvas = {
          width:
            1 +
            view.getUint16(data + 4, true) +
            view.getUint8(data + 6) * 0x10000,
          height:
            1 +
            view.getUint16(data + 7, true) +
            view.getUint8(data + 9) * 0x10000,
        };
      } else if (chunk === 'VP8 ' || chunk === 'VP8L') {
        let coded: Dimensions;
        if (chunk === 'VP8 ') {
          if (
            length < 10 ||
            data + 10 > bytes.length ||
            bytes[data + 3] !== 0x9d ||
            bytes[data + 4] !== 0x01 ||
            bytes[data + 5] !== 0x2a
          )
            return undefined;
          coded = {
            width: view.getUint16(data + 6, true) & 0x3fff,
            height: view.getUint16(data + 8, true) & 0x3fff,
          };
        } else {
          if (length < 5 || data + 5 > bytes.length || bytes[data] !== 0x2f)
            return undefined;
          const bits = view.getUint32(data + 1, true);
          coded = {
            width: (bits & 0x3fff) + 1,
            height: ((bits >>> 14) & 0x3fff) + 1,
          };
        }
        if (
          canvas &&
          (canvas.width !== coded.width || canvas.height !== coded.height)
        )
          return undefined;
        return coded;
      }
      const next = data + length + (length & 1);
      if (next > bytes.length) return undefined;
      at = next;
    }
    return undefined;
  }
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) return undefined;
    while (at < bytes.length && bytes[at] === 0xff) at++;
    if (at >= bytes.length) return undefined;
    const marker = bytes[at++]!;
    if (marker === 0x00 || marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (at + 2 > bytes.length) return undefined;
    const length = view.getUint16(at);
    if (length < 2 || at + length > bytes.length) return undefined;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (length < 8 || at + 7 > bytes.length) return undefined;
      return { width: view.getUint16(at + 5), height: view.getUint16(at + 3) };
    }
    at += length;
  }
  return undefined;
}

function safeGif(
  bytes: Uint8Array,
  size: Dimensions,
  maxPixels: number
): boolean {
  if (bytes.length < 13) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 13;
  const globalTable = bytes[10]!;
  if ((globalTable & 0x80) !== 0) at += 3 * (1 << ((globalTable & 7) + 1));
  let frames = 0;
  let pixels = 0;
  const skipBlocks = (): boolean => {
    while (at < bytes.length) {
      const length = bytes[at++]!;
      if (length === 0) return true;
      if (at + length > bytes.length) return false;
      at += length;
    }
    return false;
  };
  while (at < bytes.length) {
    const marker = bytes[at++]!;
    if (marker === 0x3b) return frames > 0;
    if (marker === 0x21) {
      if (at >= bytes.length) return false;
      at++;
      if (!skipBlocks()) return false;
      continue;
    }
    if (marker !== 0x2c || at + 9 > bytes.length) return false;
    const left = view.getUint16(at, true);
    const top = view.getUint16(at + 2, true);
    const width = view.getUint16(at + 4, true);
    const height = view.getUint16(at + 6, true);
    const flags = bytes[at + 8]!;
    at += 9;
    if (
      !width ||
      !height ||
      left + width > size.width ||
      top + height > size.height ||
      width * height > maxPixels ||
      ++frames > 1_000
    )
      return false;
    pixels += width * height;
    if (pixels > maxPixels * 4) return false;
    if ((flags & 0x80) !== 0) at += 3 * (1 << ((flags & 7) + 1));
    if (at >= bytes.length) return false;
    at++; // LZW code size
    if (!skipBlocks()) return false;
  }
  return false;
}

/** Refuse APNG before decoding, including when an ancillary chunk is large. */
function staticPng(head: Uint8Array, totalBytes: number): boolean {
  if (head.length < 8) return false;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let at = 8;
  while (at + 12 <= head.length) {
    const length = view.getUint32(at);
    const end = at + 12 + length;
    if (end > totalBytes) return false;
    const type = view.getUint32(at + 4);
    if (type === 0x6163544c) return false; // acTL
    if (type === 0x49444154) return true; // IDAT
    if (end > head.length) return false;
    at = end;
  }
  return false;
}

export async function drawPublishImage(
  source: Blob,
  head: Uint8Array,
  format: PublishImageFormat,
  target: HTMLCanvasElement,
  maxPixels: number
): Promise<boolean> {
  const size = imageDimensions(head, format);
  if (
    !size ||
    !size.width ||
    !size.height ||
    size.width * size.height > maxPixels ||
    typeof createImageBitmap !== 'function'
  )
    return false;
  if (format === 'png' && !staticPng(head, source.size)) return false;
  if (
    format === 'gif' &&
    !safeGif(new Uint8Array(await source.arrayBuffer()), size, maxPixels)
  )
    return false;
  const mime = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
  const bitmap = await createImageBitmap(source.slice(0, source.size, mime));
  try {
    if (
      !bitmap.width ||
      !bitmap.height ||
      bitmap.width * bitmap.height > maxPixels
    )
      return false;
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('Canvas unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
    const scale = Math.max(
      target.width / bitmap.width,
      target.height / bitmap.height
    );
    const width = bitmap.width * scale;
    const height = bitmap.height * scale;
    ctx.drawImage(bitmap, (target.width - width) / 2, 0, width, height);
    return true;
  } finally {
    bitmap.close();
  }
}
