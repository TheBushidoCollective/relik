import { imageSize } from 'image-size';
import { localName, parseXml } from '@relic/format/xml';
import { XmlReadBudget } from './document-xml-budget.ts';

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_TOTAL_IMAGE_PIXELS = 100_000_000;

const IMAGE_MIME: Record<string, string> = {
  avif: 'image/avif',
  bigtiff: 'image/tiff',
  bmp: 'image/bmp',
  cur: 'image/x-icon',
  dds: 'image/vnd-ms.dds',
  gif: 'image/gif',
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic-sequence',
  hevx: 'image/heic-sequence',
  icns: 'image/x-icns',
  ico: 'image/vnd.microsoft.icon',
  j2c: 'image/j2c',
  jp2: 'image/jp2',
  jpg: 'image/jpeg',
  jxl: 'image/jxl',
  'jxl-stream': 'image/jxl',
  ktx: 'image/ktx',
  mif1: 'image/heif',
  msf1: 'image/heif-sequence',
  png: 'image/png',
  pnm: 'image/x-portable-anymap',
  psd: 'image/vnd.adobe.photoshop',
  svg: 'image/svg+xml',
  tga: 'image/x-targa',
  tiff: 'image/tiff',
  webp: 'image/webp',
};
const SVG_UNITS: Record<string, number> = {
  px: 1,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
  pt: 96 / 72,
  pc: 16,
  m: 9600 / 2.54,
};

type Entry = {
  async(
    type: 'string' | 'blob' | 'uint8array'
  ): Promise<string | Blob | Uint8Array | null>;
};

type FrameCharge = (width: number, height: number) => void;

function metafileType(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 18) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) === 0x9ac6cdd7) return 'image/x-wmf';
  if (
    (view.getUint16(0, true) === 1 || view.getUint16(0, true) === 2) &&
    view.getUint16(2, true) === 9
  )
    return 'image/x-wmf';
  if (
    bytes.byteLength >= 44 &&
    view.getUint32(0, true) === 1 &&
    view.getUint32(40, true) === 0x464d4520
  )
    return 'image/x-emf';
  return undefined;
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!
  );
}

/** Count GIF image descriptors and plain-text rendering blocks. */
function chargeGif(bytes: Uint8Array, charge: FrameCharge): boolean {
  if (bytes.length < 13) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 13;
  const packed = bytes[10]!;
  if (packed & 0x80) offset += 3 * (1 << ((packed & 7) + 1));
  let frames = 0;
  const skipBlocks = (): boolean => {
    while (offset < bytes.length) {
      const size = bytes[offset++]!;
      if (size === 0) return true;
      if (size > bytes.length - offset) return false;
      offset += size;
    }
    return false;
  };
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) return frames > 0;
    if (marker === 0x21) {
      if (offset >= bytes.length) return false;
      const label = bytes[offset++]!;
      if (label === 0x01) {
        if (bytes.length - offset < 13 || bytes[offset] !== 12) return false;
        const width = view.getUint16(offset + 5, true);
        const height = view.getUint16(offset + 7, true);
        if (!width || !height) return false;
        offset += 13;
        if (!skipBlocks()) return false;
        charge(width, height);
        frames++;
      } else if (!skipBlocks()) {
        return false;
      }
      continue;
    }
    if (marker !== 0x2c || bytes.length - offset < 9) return false;
    const width = view.getUint16(offset + 4, true);
    const height = view.getUint16(offset + 6, true);
    if (!width || !height) return false;
    const flags = bytes[offset + 8]!;
    offset += 9;
    if (flags & 0x80) offset += 3 * (1 << ((flags & 7) + 1));
    if (offset >= bytes.length) return false;
    offset++; // LZW minimum code size
    if (!skipBlocks()) return false;
    charge(width, height);
    frames++;
  }
  return false;
}

/** Include the default PNG image when it is separate from the APNG frames. */
function chargePng(bytes: Uint8Array, charge: FrameCharge): boolean {
  if (bytes.length < 8 || bytes[0] !== 0x89) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  let header = false;
  let imageData = false;
  let declaredFrames: number | undefined;
  let frames = 0;
  let frameHasData = false;
  let firstFrameUsesDefault = false;
  let canvasWidth = 0;
  let canvasHeight = 0;
  while (bytes.length - offset >= 12) {
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) return false;
    const type = chunkType(bytes, offset + 4);
    const data = offset + 8;
    if (!header && type !== 'IHDR' && !(offset === 8 && type === 'CgBI'))
      return false;
    if (type === 'IHDR') {
      if (header || length !== 13) return false;
      canvasWidth = view.getUint32(data);
      canvasHeight = view.getUint32(data + 4);
      if (!canvasWidth || !canvasHeight) return false;
      header = true;
    } else if (type === 'acTL') {
      if (!header || imageData || declaredFrames !== undefined || length !== 8)
        return false;
      declaredFrames = view.getUint32(data);
      if (!declaredFrames) return false;
    } else if (type === 'fcTL') {
      if (declaredFrames === undefined || length !== 26) return false;
      if (frames && !frameHasData) return false;
      const width = view.getUint32(data + 4);
      const height = view.getUint32(data + 8);
      const x = view.getUint32(data + 12);
      const y = view.getUint32(data + 16);
      if (
        !width ||
        !height ||
        x + width > canvasWidth ||
        y + height > canvasHeight
      )
        return false;
      if (!frames && !imageData) firstFrameUsesDefault = true;
      charge(width, height);
      frames++;
      frameHasData = false;
    } else if (type === 'IDAT') {
      imageData = true;
      if (frames === 1 && firstFrameUsesDefault) frameHasData = true;
    } else if (type === 'fdAT') {
      if (!frames || !imageData || length < 4) return false;
      frameHasData = true;
    } else if (type === 'IEND') {
      if (!header || !imageData || length !== 0) return false;
      if (declaredFrames === undefined) {
        if (frames) return false;
        charge(canvasWidth, canvasHeight);
        return true;
      }
      if (frames !== declaredFrames || !frameHasData) return false;
      if (!firstFrameUsesDefault) charge(canvasWidth, canvasHeight);
      return true;
    }
    offset += length + 12;
  }
  return false;
}

function uint24le(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

/** The encoded VP8 dimensions must agree with the containing frame. */
function webpBitstreamSize(
  bytes: Uint8Array,
  type: string,
  data: number,
  length: number
): { width: number; height: number } | undefined {
  if (type === 'VP8 ') {
    if (
      length < 10 ||
      bytes[data + 3] !== 0x9d ||
      bytes[data + 4] !== 0x01 ||
      bytes[data + 5] !== 0x2a
    )
      return undefined;
    const width = (bytes[data + 6]! | (bytes[data + 7]! << 8)) & 0x3fff;
    const height = (bytes[data + 8]! | (bytes[data + 9]! << 8)) & 0x3fff;
    return width && height ? { width, height } : undefined;
  }
  if (type === 'VP8L' && length >= 5 && bytes[data] === 0x2f) {
    return {
      width: 1 + (bytes[data + 1]! | ((bytes[data + 2]! & 0x3f) << 8)),
      height:
        1 +
        ((bytes[data + 2]! >> 6) |
          (bytes[data + 3]! << 2) |
          ((bytes[data + 4]! & 0x0f) << 10)),
    };
  }
  return undefined;
}

function chargeWebp(
  bytes: Uint8Array,
  width: number,
  height: number,
  charge: FrameCharge
): boolean {
  if (bytes.length < 20) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.length || end < 20) return false;
  let offset = 12;
  let animated = false;
  let animationHeader = false;
  let frames = 0;
  let still = false;
  while (end - offset >= 8) {
    const type = chunkType(bytes, offset);
    const length = view.getUint32(offset + 4, true);
    const data = offset + 8;
    const next = data + length + (length & 1);
    if (next > end) return false;
    if (type === 'VP8X') {
      if (offset !== 12 || length !== 10) return false;
      animated = (bytes[data]! & 0x02) !== 0;
    } else if (type === 'ANIM') {
      if (!animated || animationHeader || length !== 6) return false;
      animationHeader = true;
    } else if (type === 'ANMF') {
      if (!animated || !animationHeader || length < 16) return false;
      const x = uint24le(bytes, data) * 2;
      const y = uint24le(bytes, data + 3) * 2;
      const frameWidth = uint24le(bytes, data + 6) + 1;
      const frameHeight = uint24le(bytes, data + 9) + 1;
      if (x + frameWidth > width || y + frameHeight > height) return false;
      let inner = data + 16;
      const frameEnd = data + length;
      let foundImage = false;
      while (frameEnd - inner >= 8) {
        const innerType = chunkType(bytes, inner);
        const innerLength = view.getUint32(inner + 4, true);
        const innerData = inner + 8;
        const innerNext = innerData + innerLength + (innerLength & 1);
        if (innerNext > frameEnd) return false;
        if (innerType === 'VP8 ' || innerType === 'VP8L') {
          const size = webpBitstreamSize(
            bytes,
            innerType,
            innerData,
            innerLength
          );
          if (
            foundImage ||
            !size ||
            size.width !== frameWidth ||
            size.height !== frameHeight
          )
            return false;
          foundImage = true;
        }
        inner = innerNext;
      }
      if (inner !== frameEnd || !foundImage) return false;
      charge(frameWidth, frameHeight);
      frames++;
    } else if (type === 'VP8 ' || type === 'VP8L') {
      const size = webpBitstreamSize(bytes, type, data, length);
      if (
        animated ||
        still ||
        !size ||
        size.width !== width ||
        size.height !== height
      )
        return false;
      still = true;
      charge(width, height);
    }
    offset = next;
  }
  return offset === end && (animated ? animationHeader && frames > 0 : still);
}

function bmpSize(
  bytes: Uint8Array
): { width: number; height: number } | undefined {
  if (bytes.length < 26) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = view.getUint32(14, true);
  if (headerSize === 12) {
    if (view.getUint16(22, true) !== 1) return undefined;
    return {
      width: view.getUint16(18, true),
      height: view.getUint16(20, true),
    };
  }
  if (
    ![40, 52, 56, 108, 124].includes(headerSize) ||
    headerSize > bytes.length - 14 ||
    view.getUint16(26, true) !== 1
  )
    return undefined;
  const compression = view.getUint32(30, true);
  if (![0, 1, 2, 3, 6].includes(compression)) return undefined;
  const width = view.getInt32(18, true);
  const height = view.getInt32(22, true);
  return width > 0 && height !== 0
    ? { width, height: Math.abs(height) }
    : undefined;
}

function svgLength(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match =
    /^\s*((?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(px|in|cm|mm|pt|pc|m)?\s*$/i.exec(
      value
    );
  if (!match) return undefined;
  const result =
    Number(match[1]) * SVG_UNITS[(match[2] ?? 'px').toLowerCase()]!;
  return result > 0 ? result : undefined;
}

function svgSize(
  bytes: Uint8Array
): { width: number; height: number } | undefined {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const rootTag = /<svg\s([^>"']|"[^"]*"|'[^']*')*>/.exec(text);
  if (!rootTag) return undefined;
  const tag = rootTag[0].endsWith('/>')
    ? rootTag[0]
    : `${rootTag[0].slice(0, -1)}/>`;
  const xml = parseXml(text.slice(0, rootTag.index) + tag);
  if (!xml.ok || localName(xml.root.name) !== 'svg') return undefined;
  // Width and height attributes establish an intrinsic size; a viewBox alone
  // supplies an aspect ratio, not a size.
  let width = svgLength(xml.root.attrs.get('width'));
  let height = svgLength(xml.root.attrs.get('height'));
  if (
    (xml.root.attrs.has('width') && width === undefined) ||
    (xml.root.attrs.has('height') && height === undefined)
  )
    return undefined;
  if (!width || !height) {
    const viewBox = xml.root.attrs
      .get('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      !viewBox ||
      viewBox.length !== 4 ||
      !viewBox.every(Number.isFinite) ||
      viewBox[2]! <= 0 ||
      viewBox[3]! <= 0 ||
      (!width && !height)
    )
      return undefined;
    if (!width) width = (height! * viewBox[2]!) / viewBox[3]!;
    if (!height) height = (width * viewBox[3]!) / viewBox[2]!;
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

/** Charge composited frame work for one animation cycle, before browser decode. */
export class ImageBudget {
  reason: 'too-large' | 'image-dimensions-unknown' | undefined;
  private readonly admitted = new Map<string, string>();
  private totalPixels = 0;

  constructor(
    private readonly maxImagePixels = MAX_IMAGE_PIXELS,
    private readonly maxTotalPixels = MAX_TOTAL_IMAGE_PIXELS
  ) {}

  type(path: string): string | undefined {
    return this.admitted.get(path);
  }

  admit(path: string, bytes: Uint8Array): boolean {
    if (this.reason !== undefined) return false;
    if (this.admitted.has(path)) return true;
    const metafile = metafileType(bytes);
    if (metafile) {
      this.admitted.set(path, metafile);
      return true;
    }
    try {
      const image = imageSize(bytes);
      const mime =
        image.type === undefined ? undefined : IMAGE_MIME[image.type];
      const dimensions =
        image.type === 'svg'
          ? svgSize(bytes)
          : image.type === 'bmp'
            ? (bmpSize(bytes) ?? image)
            : image;
      if (
        !mime ||
        !dimensions ||
        !(dimensions.width > 0) ||
        !(dimensions.height > 0)
      ) {
        this.reason = 'image-dimensions-unknown';
        return false;
      }
      const { width, height } = dimensions;
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        this.reason = 'too-large';
        return false;
      }
      const canvasPixels = width * height;
      if (
        !Number.isSafeInteger(canvasPixels) ||
        canvasPixels > this.maxImagePixels ||
        canvasPixels > this.maxTotalPixels - this.totalPixels
      ) {
        this.reason = 'too-large';
        return false;
      }
      let pixels = 0;
      let tooLarge = false;
      const charge: FrameCharge = (frameWidth, frameHeight) => {
        const framePixels = Math.max(canvasPixels, frameWidth * frameHeight);
        if (
          !Number.isSafeInteger(framePixels) ||
          framePixels > this.maxImagePixels - pixels ||
          framePixels > this.maxTotalPixels - this.totalPixels - pixels
        ) {
          tooLarge = true;
        } else {
          pixels += framePixels;
        }
      };
      let readable = true;
      if (image.type === 'gif') readable = chargeGif(bytes, charge);
      else if (image.type === 'png') readable = chargePng(bytes, charge);
      else if (image.type === 'webp')
        readable = chargeWebp(bytes, width, height, charge);
      else charge(width, height);
      if (!readable) {
        this.reason = 'image-dimensions-unknown';
        return false;
      }
      if (tooLarge) {
        this.reason = 'too-large';
        return false;
      }
      this.totalPixels += pixels;
      this.admitted.set(path, mime);
      return true;
    } catch {
      this.reason = 'image-dimensions-unknown';
      return false;
    }
  }
}

export interface EntryArchiveInput {
  readonly entries: ReadonlyMap<string, Uint8Array>;
  readonly budget: ImageBudget;
  readonly xmlBudget?: XmlReadBudget;
}

/** docx-preview reads an already validated and decompressed package. */
export default class EntryArchive {
  readonly files: Record<string, Entry> = Object.create(null);

  static async loadAsync(
    input: ReadonlyMap<string, Uint8Array> | EntryArchiveInput
  ): Promise<EntryArchive> {
    const archive = new EntryArchive();
    const entries = 'budget' in input ? input.entries : input;
    const budget = 'budget' in input ? input.budget : undefined;
    const xmlBudget =
      ('budget' in input ? input.xmlBudget : undefined) ?? new XmlReadBudget();
    for (const [path, bytes] of entries) {
      let blob: Blob | undefined;
      archive.files[path] = {
        async async(type) {
          if (type === 'string') return xmlBudget.read(bytes);
          if (type === 'uint8array') return bytes;
          if (type === 'blob') {
            if (budget && !budget.admit(path, bytes)) return null;
            const mime = budget?.type(path);
            blob ??=
              mime === 'image/x-wmf' || mime === 'image/x-emf'
                ? new Blob([], { type: mime })
                : new Blob([bytes as Uint8Array<ArrayBuffer>], {
                    type: mime ?? '',
                  });
            return blob;
          }
          throw new Error('Unsupported entry type');
        },
      };
    }
    return archive;
  }
}
