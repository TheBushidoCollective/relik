import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type * as PdfJsModule from 'pdfjs-dist';
import {
  contentFromBlob,
  contentFromBytes,
  MAX_CONTENT_READ_BYTES,
  type RelicContent,
} from '../src/content.ts';
import type * as PdfModule from '../src/pdf.ts';

let pdfjs: typeof PdfJsModule;
let pdf: typeof PdfModule;
let originalDOMMatrix: PropertyDescriptor | undefined;

beforeAll(async () => {
  originalDOMMatrix = Object.getOwnPropertyDescriptor(globalThis, 'DOMMatrix');
  // PDF.js constructs an identity matrix at module load, even without a canvas.
  if (typeof globalThis.DOMMatrix === 'undefined') {
    Object.defineProperty(globalThis, 'DOMMatrix', {
      configurable: true,
      value: class DOMMatrix {},
    });
  }
  // PDF.js needs DOMMatrix before either module can load in the test runtime.
  pdfjs = await import('pdfjs-dist');
  pdf = await import('../src/pdf.ts');
});

afterAll(() => {
  if (originalDOMMatrix) {
    Object.defineProperty(globalThis, 'DOMMatrix', originalDOMMatrix);
  } else {
    Reflect.deleteProperty(globalThis, 'DOMMatrix');
  }
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

/**
 * Two pages either side of a run of NUL bytes, which PDF treats as whitespace.
 * Page 1's objects sit in the initial read; page 2's objects and the
 * cross-reference table sit in the final 64 KiB.
 */
function pdfWithWhitespaceRun(size: number): Uint8Array {
  const operators = '0 0 100 100 re f\n';
  const contentStream = `<< /Length ${operators.length} >>\nstream\n${operators}endstream`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>',
    contentStream,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R >>',
    contentStream,
  ];
  const offsets: number[] = [];
  let head = '%PDF-1.4\n';
  for (const [index, object] of objects.slice(0, 4).entries()) {
    offsets.push(head.length);
    head += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  // Every number in the tail is padded, so its length does not depend on where it starts.
  const tail = (start: number): string => {
    let text = '';
    const tailOffsets: number[] = [];
    for (const [index, object] of objects.slice(4).entries()) {
      tailOffsets.push(start + text.length);
      text += `${index + 5} 0 obj\n${object}\nendobj\n`;
    }
    const xref = start + text.length;
    text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of [...offsets, ...tailOffsets]) {
      text += `${String(offset).padStart(10, '0')} 00000 n \n`;
    }
    return `${text}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${String(xref).padStart(10, '0')}\n%%EOF\n`;
  };
  const start = size - tail(0).length;
  const encoder = new TextEncoder();
  const bytes = new Uint8Array(size);
  bytes.set(encoder.encode(head), 0);
  bytes.set(encoder.encode(tail(start)), start);
  return bytes;
}

type PdfWorkerHandler = {
  initializeFromPort(port: MessagePort): void;
};

type ParserWorkers = {
  patched: PdfWorkerHandler;
  original: PdfWorkerHandler;
};

type ParserFixtureTarget =
  | 'annotation-array'
  | 'annotation'
  | 'resources'
  | 'content';

function parserFixture(
  object: string,
  target: ParserFixtureTarget,
  truncateAtEof = false,
  afterObject = ''
): Uint8Array {
  const operators = '0 0 100 100 re f\n';
  const annotations =
    target === 'annotation-array'
      ? '5 0 R'
      : target === 'annotation'
        ? '[5 0 R]'
        : '[]';
  const resources = target === 'resources' ? '5 0 R' : '<< >>';
  const contents = target === 'content' ? '5 0 R' : '4 0 R';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contents} /Annots ${annotations} /Resources ${resources} >>`,
    `<< /Length ${operators.length} >>\nstream\n${operators}endstream`,
    object,
    '<< /Type /Annot /Subtype /Text /Rect [10 10 40 40] /Contents (after closer) >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = Array<number>(objects.length).fill(0);
  for (const [index, value] of objects.entries()) {
    if (truncateAtEof && index === 4) continue;
    offsets[index] = body.length;
    body += `${index + 1} 0 obj\n${value}\nendobj\n`;
    if (index === 4) body += afterObject;
  }
  const xrefOffset = body.length;
  const xref = (lastObjectOffset: number): string => {
    let result = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const [index, offset] of offsets.entries()) {
      const position = truncateAtEof && index === 4 ? lastObjectOffset : offset;
      result += `${String(position).padStart(10, '0')} 00000 n \n`;
    }
    return `${result}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  };
  if (truncateAtEof) {
    // Put the referenced, incomplete object after the trailer so its parser
    // reaches the physical EOF rather than consuming the xref as object data.
    const lastObjectOffset = body.length + xref(0).length;
    body += `${xref(lastObjectOffset)}5 0 obj\n${object}`;
  } else {
    body += xref(0);
  }
  return new TextEncoder().encode(body);
}

async function parserWorkers(): Promise<ParserWorkers> {
  const workerUrl = new URL(
    '../node_modules/pdfjs-dist/build/pdf.worker.mjs',
    import.meta.url
  );
  const source = await Bun.file(workerUrl).text();
  const lexerCall = 'new IndirectObjectLexer(stream)';
  expect(source.split(lexerCall).length - 1).toBe(3);
  // This restores the three parser call sites to the upstream Lexer. The
  // baseline and patched workers otherwise execute the same installed code.
  const originalSource = source.replaceAll(lexerCall, 'new Lexer(stream)');
  const originalUrl = `data:text/javascript;base64,${Buffer.from(originalSource).toString('base64')}`;
  const globalWorker = Object.getOwnPropertyDescriptor(
    globalThis,
    'pdfjsWorker'
  );
  // The worker URLs are constructed at runtime so each parser can have its
  // own worker message handler without changing the installed module.
  try {
    const patchedModule = (await import(workerUrl.href)) as {
      WorkerMessageHandler: PdfWorkerHandler;
    };
    const originalModule = (await import(originalUrl)) as {
      WorkerMessageHandler: PdfWorkerHandler;
    };
    return {
      patched: patchedModule.WorkerMessageHandler,
      original: originalModule.WorkerMessageHandler,
    };
  } finally {
    if (globalWorker) {
      Object.defineProperty(globalThis, 'pdfjsWorker', globalWorker);
    } else {
      Reflect.deleteProperty(globalThis, 'pdfjsWorker');
    }
  }
}

async function inspectWithWorker(
  handler: PdfWorkerHandler,
  original: Uint8Array
): Promise<{ view: number[]; operators: number[]; annotations: string[] }> {
  const channel = new MessageChannel();
  handler.initializeFromPort(channel.port2);
  const worker = pdfjs.PDFWorker.create({
    port: channel.port1 as unknown as Worker,
  });
  // PDF.js transfers its input buffer. Keep the caller's bytes for comparison.
  const task = pdfjs.getDocument({ data: original.slice(), worker });
  try {
    const document = await task.promise;
    expect(document.numPages).toBe(1);
    const downloaded = await document.getData();
    expect(Buffer.compare(Buffer.from(downloaded), Buffer.from(original))).toBe(
      0
    );
    const page = await document.getPage(1);
    const annotations = await page.getAnnotations();
    const operators = await page.getOperatorList({
      annotationMode: pdfjs.AnnotationMode.DISABLE,
    });
    const pathIndex = operators.fnArray.indexOf(pdfjs.OPS.constructPath);
    expect(pathIndex).toBeGreaterThanOrEqual(0);
    expect(operators.argsArray[pathIndex]?.[0]).toBe(pdfjs.OPS.fill);
    return {
      view: page.view,
      operators: operators.fnArray,
      annotations: annotations.map((annotation) => annotation.contentsObj.str),
    };
  } finally {
    try {
      await task.destroy();
    } finally {
      worker.destroy();
      channel.port1.close();
      channel.port2.close();
    }
  }
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

  test('renders the pages either side of a whitespace run without fetching the run', async () => {
    const size = 5 * 1024 * 1024;
    const original = pdfWithWhitespaceRun(size);
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
      expect(document.numPages).toBe(2);
      for (const pageNumber of [1, 2]) {
        const page = await document.getPage(pageNumber);
        const operators = await Promise.race([page.getOperatorList(), failure]);
        expect(operators.fnArray.length).toBeGreaterThan(0);
      }
      // Unpatched pdf.js lexes one token past page 1's content object, which
      // walks the run one 64 KiB range request at a time.
      const initialBytes = 1024 * 1024;
      const lastChunk = size - 65_536;
      expect(reads[0]).toEqual([0, initialBytes]);
      expect(reads).toContainEqual([lastChunk, size]);
      expect(
        reads.filter(([start, end]) => start < lastChunk && end > initialBytes)
      ).toEqual([]);
      const downloaded = new Uint8Array(
        await content.blob('application/pdf').arrayBuffer()
      );
      expect(
        Buffer.compare(Buffer.from(downloaded), Buffer.from(original))
      ).toBe(0);
    } finally {
      await task.destroy();
    }
  }, 30_000);

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

describe('PDF.js indirect-object parser compatibility', () => {
  let workers: ParserWorkers;

  beforeAll(async () => {
    workers = await parserWorkers();
  });

  const annotation =
    '/Type /Annot /Subtype /Text /Rect [10 10 40 40] /Contents (after closer)';
  const cases: Array<{
    name: string;
    object: string;
    target: ParserFixtureTarget;
    annotations: string[];
    truncateAtEof?: boolean;
  }> = [
    {
      name: 'dictionary closer inside an array',
      object: '[ >> endobj ]',
      target: 'annotation-array',
      annotations: [],
    },
    {
      name: 'array closer inside a dictionary',
      object: '<< /A ] /B endobj >>',
      target: 'resources',
      annotations: [],
    },
    {
      name: 'dictionary closer used as a dictionary value',
      object: '<< /A >> /B endobj >>',
      target: 'resources',
      annotations: [],
    },
    {
      name: 'an array keeps entries after a mismatched closer',
      object: '[ >> endobj 6 0 R ]',
      target: 'annotation-array',
      annotations: ['after closer'],
    },
    {
      name: 'a dictionary keeps entries after a mismatched closer',
      object: `<< /A ] /B endobj ${annotation} >>`,
      target: 'annotation',
      annotations: ['after closer'],
    },
    {
      name: 'dictionary closer used as a value before annotation fields',
      object: `<< /A >> /B endobj ${annotation} >>`,
      target: 'annotation',
      annotations: ['after closer'],
    },
    {
      name: 'nested array retains a dictionary and following annotation',
      object: '[ << /A ] ] endobj >> 6 0 R ]',
      target: 'annotation-array',
      annotations: ['', 'after closer'],
    },
    {
      name: 'nested dictionary retains an array and following keys',
      object: `<< /A [ >> >> endobj ] ${annotation} >>`,
      target: 'annotation',
      annotations: ['after closer'],
    },
    {
      name: 'strings, names, hex strings and comments containing delimiters',
      object:
        '[ (endobj \\) ] >>) /endobj <656e646f626a> % ] >> endobj\n << /Unused [(endobj) /endobj] >> 6 0 R ]',
      target: 'annotation-array',
      annotations: ['', 'after closer'],
    },
    {
      name: 'a top-level inline image containing an endobj value',
      // If endobj is misread as the object boundary, q becomes a spurious
      // graphics operator instead of remaining an inline-image header value.
      object: 'BI /W endobj /H q ID\n0 0 100 100 re f\nEI',
      target: 'content',
      annotations: [],
    },
    {
      name: 'a dictionary whose endobj terminates at physical EOF',
      object: '<< >>\nendobj',
      target: 'resources',
      annotations: [],
      truncateAtEof: true,
    },
    {
      name: 'an array whose endobj terminates at physical EOF',
      object: '[ ]\nendobj',
      target: 'annotation-array',
      annotations: [],
      truncateAtEof: true,
    },
    ...[1023, 1024, 1025].map((depth) => ({
      name: `nested resource arrays at depth ${depth}`,
      object: `<< /A ${'['.repeat(depth)} (endobj) ${']'.repeat(depth)} /B endobj >>`,
      target: 'resources' as const,
      annotations: [],
    })),
  ];

  for (const fixture of cases) {
    test(`matches the original worker for ${fixture.name}`, async () => {
      const bytes = parserFixture(
        fixture.object,
        fixture.target,
        fixture.truncateAtEof
      );
      const expected = await inspectWithWorker(workers.original, bytes);
      expect(expected.view).toEqual([0, 0, 200, 200]);
      expect(expected.annotations).toEqual(fixture.annotations);
      const actual = await inspectWithWorker(workers.patched, bytes);
      expect(actual).toEqual(expected);
    }, 15_000);
  }

  test('falls back to original lookahead above the nesting limit', async () => {
    const depth = 1025;
    const object = `<< /A ${'['.repeat(depth)} (endobj) ${']'.repeat(depth)} >>`;
    // Upstream looks past endobj and encounters this illegal token. The
    // bounded tracker must also defer to upstream after exceeding its limit.
    // /Annots forces the object to be parsed by getAnnotations(), whose
    // rejection preserves the worker error. PDF.js can resolve an empty
    // operator list after a resource-parsing error instead of rejecting.
    const bytes = parserFixture(object, 'annotation-array', false, ')\n');
    await expect(inspectWithWorker(workers.original, bytes)).rejects.toThrow(
      'Illegal character: 41'
    );
    await expect(inspectWithWorker(workers.patched, bytes)).rejects.toThrow(
      'Illegal character: 41'
    );
  }, 15_000);

  const eofCases: Array<{
    name: string;
    object: string;
    target: ParserFixtureTarget;
    error: string;
  }> = [
    {
      name: 'array with a mismatched closer',
      object: '[ >> endobj',
      target: 'annotation-array',
      error: 'End of file inside array.',
    },
    {
      name: 'dictionary with a mismatched closer',
      object: '<< /A ] /B endobj',
      target: 'annotation-array',
      error: 'End of file inside dictionary.',
    },
    {
      name: 'array containing an unterminated dictionary',
      object: '[ << /A ] /B endobj',
      target: 'annotation-array',
      error: 'End of file inside dictionary.',
    },
    {
      name: 'dictionary containing an unterminated array',
      object: '<< /A [ >> endobj',
      target: 'annotation-array',
      error: 'End of file inside array.',
    },
  ];

  for (const fixture of eofCases) {
    test(`matches the original worker at physical EOF in ${fixture.name}`, async () => {
      const bytes = parserFixture(fixture.object, fixture.target, true);
      await expect(inspectWithWorker(workers.original, bytes)).rejects.toThrow(
        fixture.error
      );
      await expect(inspectWithWorker(workers.patched, bytes)).rejects.toThrow(
        fixture.error
      );
    }, 15_000);
  }
});
