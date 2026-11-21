import { imageSize } from 'image-size';
import { XmlReadBudget } from './document-xml-budget.ts';

const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_TOTAL_IMAGE_PIXELS = 100_000_000;

type Entry = {
  async(
    type: 'string' | 'blob' | 'uint8array'
  ): Promise<string | Blob | Uint8Array | null>;
};

function isMetafile(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 18) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) === 0x9ac6cdd7) return true;
  if (
    (view.getUint16(0, true) === 1 || view.getUint16(0, true) === 2) &&
    view.getUint16(2, true) === 9
  )
    return true;
  return (
    bytes.byteLength >= 44 &&
    view.getUint32(0, true) === 1 &&
    view.getUint32(40, true) === 0x464d4520
  );
}

/** Charge each image member before handing it to the browser decoder. */
export class ImageBudget {
  reason: 'too-large' | 'image-dimensions-unknown' | undefined;
  private readonly admitted = new Set<string>();
  private totalPixels = 0;

  constructor(
    private readonly maxImagePixels = MAX_IMAGE_PIXELS,
    private readonly maxTotalPixels = MAX_TOTAL_IMAGE_PIXELS
  ) {}

  admit(path: string, bytes: Uint8Array): boolean {
    if (this.reason !== undefined) return false;
    if (this.admitted.has(path)) return true;
    // Metafiles are replaced with a notice instead of being decoded.
    if (isMetafile(bytes)) {
      this.admitted.add(path);
      return true;
    }
    try {
      const { width, height } = imageSize(bytes);
      if (
        !Number.isSafeInteger(width) ||
        !Number.isSafeInteger(height) ||
        width <= 0 ||
        height <= 0
      ) {
        this.reason = 'image-dimensions-unknown';
        return false;
      }
      const pixels = width * height;
      if (
        !Number.isSafeInteger(pixels) ||
        pixels > this.maxImagePixels ||
        pixels > this.maxTotalPixels - this.totalPixels
      ) {
        this.reason = 'too-large';
        return false;
      }
      this.totalPixels += pixels;
      this.admitted.add(path);
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
            blob ??= new Blob([bytes as Uint8Array<ArrayBuffer>]);
            return blob;
          }
          throw new Error('Unsupported entry type');
        },
      };
    }
    return archive;
  }
}
