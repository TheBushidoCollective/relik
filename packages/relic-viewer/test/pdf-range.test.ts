import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  contentFromBlob,
  contentFromBytes,
  MAX_CONTENT_READ_BYTES,
  type RelicContent,
} from '../src/content.ts';
import type * as PdfModule from '../src/pdf.ts';

let pdf: typeof PdfModule;
const originalDOMMatrix = Object.getOwnPropertyDescriptor(
  globalThis,
  'DOMMatrix'
);

beforeAll(async () => {
  // PDF.js constructs an identity matrix at module load, even without a canvas.
  if (!originalDOMMatrix) {
    Object.defineProperty(globalThis, 'DOMMatrix', {
      configurable: true,
      value: class DOMMatrix {},
    });
  }
  // PDF.js needs DOMMatrix before this module can load in the test runtime.
  pdf = await import('../src/pdf.ts');
});

afterAll(() => {
  if (!originalDOMMatrix) Reflect.deleteProperty(globalThis, 'DOMMatrix');
});

function fixturePdf(padding: number): Uint8Array {
  const operators = '0 0 100 100 re f\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    `<< /Length ${operators.length} >>\nstream\n${operators}endstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  body += `%${'x'.repeat(padding)}\n`;
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

describe('PDF Blob range access', () => {
  test('splits coalesced ranges and preserves the downloadable bytes after transfer', async () => {
    const piece = new Uint8Array(new ArrayBuffer(1024 * 1024));
    for (let index = 0; index < piece.length; index++)
      piece[index] = index % 251;
    const base = await contentFromBlob(new Blob(Array(19).fill(piece)));
    const reads: Array<[number, number]> = [];
    const content: RelicContent = {
      ...base,
      async read(start, end) {
        reads.push([start, end]);
        return base.read(start, end);
      },
    };
    const result = Promise.withResolvers<{
      begin: number;
      bytes: Uint8Array;
    }>();
    const transport = new pdf.RelicPdfRangeTransport(
      content,
      new Uint8Array(),
      result.reject
    );
    transport.addRangeListener((begin: number, bytes: Uint8Array) =>
      result.resolve({ begin, bytes })
    );
    const begin = 123;
    const end = MAX_CONTENT_READ_BYTES + 200_123;
    transport.requestDataRange(begin, end);
    const range = await result.promise;
    expect(range.begin).toBe(begin);
    expect(range.bytes.byteLength).toBe(end - begin);
    expect(reads.length).toBe(2);
    expect(
      reads.every(([start, stop]) => stop - start <= MAX_CONTENT_READ_BYTES)
    ).toBe(true);
    const expected = new Uint8Array(
      await base.blob('').slice(begin, end).arrayBuffer()
    );
    expect(
      Buffer.compare(Buffer.from(range.bytes), Buffer.from(expected))
    ).toBe(0);

    structuredClone(range.bytes.buffer, {
      transfer: [range.bytes.buffer as ArrayBuffer],
    });
    expect(range.bytes.byteLength).toBe(0);
    const downloaded = new Uint8Array(
      await content.blob('application/octet-stream').arrayBuffer()
    );
    expect(downloaded.byteLength).toBe(piece.length * 19);
    for (let offset = 0; offset < downloaded.length; offset += piece.length) {
      expect(
        Buffer.compare(
          Buffer.from(downloaded.subarray(offset, offset + piece.length)),
          Buffer.from(piece)
        )
      ).toBe(0);
    }
  });

  test('opens a PDF whose cross-reference is past the initial megabyte without detaching download', async () => {
    const original = fixturePdf(1024 * 1024 + 1024);
    const base = contentFromBytes(original);
    const reads: Array<[number, number]> = [];
    const content: RelicContent = {
      ...base,
      async read(start, end) {
        reads.push([start, end]);
        return base.read(start, end);
      },
    };
    const { task, failure } = await pdf.createPdfLoadingTask(content);
    try {
      const document = await Promise.race([task.promise, failure]);
      expect(document.numPages).toBe(1);
      const page = await document.getPage(1);
      const operators = await Promise.race([page.getOperatorList(), failure]);
      expect(operators.fnArray.length).toBeGreaterThan(0);
      expect(reads[0]).toEqual([0, 1024 * 1024]);
      expect(reads.some(([, end]) => end > 1024 * 1024)).toBe(true);
      expect(
        reads.every(([start, end]) => end - start <= MAX_CONTENT_READ_BYTES)
      ).toBe(true);
      const downloaded = new Uint8Array(
        await content.blob('application/pdf').arrayBuffer()
      );
      expect(
        Buffer.compare(Buffer.from(downloaded), Buffer.from(original))
      ).toBe(0);
    } finally {
      await task.destroy();
    }
  });

  test('reports a failed range rather than leaving the PDF load pending', async () => {
    const base = contentFromBytes(fixturePdf(1024 * 1024 + 1024));
    const content: RelicContent = {
      ...base,
      async read(start, end) {
        if (start !== 0 || end !== 1024 * 1024)
          throw new Error('storage read failed');
        return base.read(start, end);
      },
    };
    const { task, failure } = await pdf.createPdfLoadingTask(content);
    try {
      await expect(Promise.race([task.promise, failure])).rejects.toThrow(
        'storage read failed'
      );
    } finally {
      await task.destroy();
    }
  });

  test('cancels before creating a PDF task when the initial read is pending', async () => {
    const base = contentFromBytes(new Uint8Array([1, 2, 3]));
    const pending = Promise.withResolvers<Uint8Array>();
    const content: RelicContent = { ...base, read: () => pending.promise };
    const controller = new AbortController();
    const opening = pdf.createPdfLoadingTask(content, controller.signal);
    controller.abort();
    pending.resolve(new Uint8Array([1, 2, 3]));
    await expect(opening).rejects.toThrow('PDF loading cancelled');
  });

  test('ignores range completion after abort and rejects invalid ranges', async () => {
    const base = contentFromBytes(new Uint8Array([1, 2, 3]));
    const pending = Promise.withResolvers<Uint8Array>();
    const content: RelicContent = { ...base, read: () => pending.promise };
    let delivered = false;
    let failed = false;
    const transport = new pdf.RelicPdfRangeTransport(
      content,
      new Uint8Array(),
      () => {
        failed = true;
      }
    );
    transport.addRangeListener(() => {
      delivered = true;
    });
    transport.requestDataRange(0, 3);
    transport.abort();
    pending.resolve(new Uint8Array([1, 2, 3]));
    await pending.promise;
    await Promise.resolve();
    expect(delivered).toBe(false);
    expect(failed).toBe(false);

    const invalid = Promise.withResolvers<never>();
    const second = new pdf.RelicPdfRangeTransport(
      base,
      new Uint8Array(),
      invalid.reject
    );
    second.requestDataRange(-1, 1);
    await expect(invalid.promise).rejects.toBeInstanceOf(RangeError);
  });
});
