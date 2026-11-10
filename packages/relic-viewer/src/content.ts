export const CONTENT_BATCH_BYTES = 8 * 1024 * 1024;
export const CONTENT_HEAD_BYTES = 65_536;
export const CONTENT_TAIL_BYTES = 65_557;
export const MAX_CONTENT_READ_BYTES = 16 * 1024 * 1024;
export const DOCUMENT_RENDER_LIMIT_BYTES = 100 * 1024 * 1024;

export interface RelicContent {
  readonly size: number;
  readonly head: Uint8Array;
  readonly tail: Uint8Array;
  blob(type: string): Blob;
  read(start: number, end: number): Promise<Uint8Array>;
  readWhole(limit: number): Promise<Uint8Array | undefined>;
}

/** The browser could not create or read its backing Blob. */
export class ContentStoreError extends Error {
  constructor(cause?: unknown) {
    super('The browser could not hold the decrypted content.', { cause });
    this.name = 'ContentStoreError';
  }
}

function checkedBlob(parts: BlobPart[], type?: string): Blob {
  try {
    return new Blob(parts, type === undefined ? undefined : { type });
  } catch (cause) {
    throw new ContentStoreError(cause);
  }
}

function sliceBlob(
  blob: Blob,
  start: number,
  end: number,
  type?: string
): Blob {
  try {
    return blob.slice(start, end, type);
  } catch (cause) {
    throw new ContentStoreError(cause);
  }
}

async function readBlob(blob: Blob): Promise<Uint8Array> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.length !== blob.size) throw new Error('short Blob read');
    return bytes;
  } catch (cause) {
    throw new ContentStoreError(cause);
  }
}

function contentFromParts(
  base: Blob,
  head: Uint8Array,
  tail: Uint8Array
): RelicContent {
  return {
    size: base.size,
    head,
    tail,
    blob(type) {
      return sliceBlob(base, 0, base.size, type);
    },
    async read(start, end) {
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end < start ||
        end > base.size ||
        end - start > MAX_CONTENT_READ_BYTES
      ) {
        throw new RangeError('Invalid or oversized content read');
      }
      return readBlob(sliceBlob(base, start, end));
    },
    async readWhole(limit) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 0 ||
        limit > DOCUMENT_RENDER_LIMIT_BYTES
      ) {
        throw new RangeError('Invalid whole-content read limit');
      }
      if (base.size > limit) return undefined;
      return readBlob(base);
    },
  };
}

export interface ContentSink {
  write(chunk: Uint8Array): void;
  finish(): Promise<RelicContent>;
}

/** Owns chunks passed to write; callers must not mutate them afterwards. */
export function createContentSink(length: number): ContentSink {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new RangeError('Invalid content length');
  const head = new Uint8Array(Math.min(length, CONTENT_HEAD_BYTES));
  const tail = new Uint8Array(Math.min(length, CONTENT_TAIL_BYTES));
  const parts: Blob[] = [];
  let batch: BlobPart[] = [];
  let batchLength = 0;
  let written = 0;
  let finished = false;

  function flush(): void {
    if (batchLength === 0) return;
    parts.push(checkedBlob(batch));
    batch = [];
    batchLength = 0;
  }

  return {
    write(chunk) {
      if (finished || written + chunk.length > length)
        throw new RangeError('Unexpected content length');
      if (written < head.length) {
        head.set(
          chunk.subarray(0, Math.min(chunk.length, head.length - written)),
          written
        );
      }
      // Copy only the intersection with the final tail, including across records.
      const tailStart = length - tail.length;
      const from = Math.max(written, tailStart);
      const to = written + chunk.length;
      if (to > from) tail.set(chunk.subarray(from - written), from - tailStart);
      written = to;
      let offset = 0;
      while (offset < chunk.length) {
        const count = Math.min(
          chunk.length - offset,
          CONTENT_BATCH_BYTES - batchLength
        );
        batch.push(chunk.subarray(offset, offset + count) as BlobPart);
        batchLength += count;
        offset += count;
        if (batchLength === CONTENT_BATCH_BYTES) flush();
      }
    },
    async finish() {
      if (finished || written !== length)
        throw new RangeError('Unexpected content length');
      finished = true;
      flush();
      const base = checkedBlob(parts);
      if (base.size !== length)
        throw new ContentStoreError(new Error('short Blob'));
      if (length !== 0) await readBlob(sliceBlob(base, length - 1, length));
      return contentFromParts(base, head, tail);
    },
  };
}

export function contentFromBytes(bytes: Uint8Array): RelicContent {
  const base = checkedBlob([bytes as BlobPart]);
  return contentFromParts(
    base,
    bytes.slice(0, CONTENT_HEAD_BYTES),
    bytes.slice(Math.max(0, bytes.length - CONTENT_TAIL_BYTES))
  );
}

export async function contentFromBlob(blob: Blob): Promise<RelicContent> {
  const [head, tail] = await Promise.all([
    readBlob(sliceBlob(blob, 0, Math.min(blob.size, CONTENT_HEAD_BYTES))),
    readBlob(
      sliceBlob(blob, Math.max(0, blob.size - CONTENT_TAIL_BYTES), blob.size)
    ),
  ]);
  return contentFromParts(blob, head, tail);
}
