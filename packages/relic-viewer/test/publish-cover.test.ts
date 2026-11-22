import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  COVER_HEIGHT,
  COVER_WIDTH,
  crc32,
  validateCoverRaster,
} from '@relic/format/cover';
import {
  generateCoverPreview,
  uploadPublishCover,
  type CoverPreviewSource,
} from '../src/publish-cover.ts';
import { preserveGlobalDescriptors } from './global-descriptors.ts';

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Canvas output carries metadata that must be removed before the review image. */
function canvasRaster(): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, COVER_WIDTH);
  view.setUint32(4, COVER_HEIGHT);
  header[8] = 8;
  header[9] = 6;
  const pixels = new Uint8Array(COVER_HEIGHT * (1 + COVER_WIDTH * 4));
  return concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('tEXt', new TextEncoder().encode('secret metadata')),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', new Uint8Array())
  );
}

function source(
  name: string,
  content: string,
  mimetype = 'text/plain'
): CoverPreviewSource {
  const blob = new Blob([content], { type: mimetype });
  return {
    name,
    mimetype,
    size: blob.size,
    async read(maxBytes) {
      return blob.size <= maxBytes ? blob : undefined;
    },
  };
}

function installCanvas(
  raster: Uint8Array,
  lines: string[],
  created: string[]
): void {
  const context = {
    fillStyle: '',
    font: '',
    textBaseline: '',
    fillRect() {},
    fillText(text: string) {
      lines.push(text);
    },
  };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement(name: string) {
        created.push(name);
        if (name !== 'canvas') throw new Error(`Unexpected element ${name}`);
        return {
          width: 0,
          height: 0,
          getContext(kind: string) {
            if (kind !== '2d') throw new Error('Unexpected canvas context');
            return context;
          },
          toBlob(callback: (blob: Blob | null) => void, type: string) {
            callback(
              type === 'image/png'
                ? new Blob([raster as BlobPart], { type })
                : null
            );
          },
        };
      },
    },
  });
}

/** Use the platform stream when present; provide the same zlib operation otherwise. */
function ensureDecompressionStream(): void {
  if (typeof DecompressionStream !== 'undefined') return;
  class ZlibDecompressionStream {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    constructor(format: string) {
      if (format !== 'deflate')
        throw new Error('Unexpected compression format');
      const chunks: Uint8Array[] = [];
      const stream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk) {
          chunks.push(chunk);
        },
        flush(controller) {
          controller.enqueue(
            new Uint8Array(inflateSync(Buffer.concat(chunks)))
          );
        },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
    }
  }
  Object.defineProperty(globalThis, 'DecompressionStream', {
    configurable: true,
    value: ZlibDecompressionStream,
  });
}

describe('browser publish covers', () => {
  let restore: () => void;
  let lines: string[];
  let created: string[];
  let networkCalls: string[];

  beforeEach(() => {
    restore = preserveGlobalDescriptors(
      'document',
      'fetch',
      'DecompressionStream'
    );
    lines = [];
    created = [];
    networkCalls = [];
    installCanvas(canvasRaster(), lines, created);
    ensureDecompressionStream();
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: async (input: RequestInfo | URL) => {
        networkCalls.push(String(input));
        throw new Error('Unexpected network request while reviewing');
      },
    });
  });

  afterEach(() => restore());

  test('uploads the exact normalized Blob shown for approval', async () => {
    const result = await generateCoverPreview(
      source('report.md', '# Public excerpt\nA line')
    );
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') throw new Error('Expected a preview');
    expect(result.preview.kind).toBe('markdown');
    expect(result.preview.type).toBe('image/png');
    expect(lines).toEqual(['# Public excerpt', 'A line']);
    expect(networkCalls).toEqual([]);

    const approved = new Uint8Array(await result.preview.blob.arrayBuffer());
    expect(Buffer.from(approved).includes(Buffer.from('secret metadata'))).toBe(
      false
    );
    expect(
      validateCoverRaster(approved, (bytes, maxOutputLength) =>
        inflateSync(bytes, { maxOutputLength })
      )
    ).toEqual({ ok: true, type: 'image/png' });
    const expectedHash = createHash('sha256').update(approved).digest('hex');
    let calls = 0;
    const fetcher = async (
      input: RequestInfo | URL,
      init?: RequestInit
    ): Promise<Response> => {
      calls++;
      expect(String(input)).toBe(
        'https://example.test/api/relics/relic123/cover'
      );
      expect(init?.method).toBe('POST');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body['publish_token']).toBe('submission-token');
      expect(body['version']).toBe(1);
      expect(body['kind']).toBe('markdown');
      expect(body['type']).toBe('image/png');
      expect(
        new Uint8Array(Buffer.from(String(body['data']), 'base64'))
      ).toEqual(approved);
      return Response.json({
        relic_id: 'relic123',
        version: 1,
        kind: body['kind'],
        type: body['type'],
        bytes: approved.length,
        sha256: expectedHash,
      });
    };
    const upload = await uploadPublishCover(
      'https://example.test',
      'relic123',
      'submission-token',
      result.preview,
      fetcher
    );
    expect(upload).toEqual({ status: 'uploaded' });
    expect(calls).toBe(1);
    expect(JSON.stringify(upload)).not.toContain('submission-token');
  });

  test('distinguishes a service refusal from lost or mismatched acknowledgements', async () => {
    const result = await generateCoverPreview(source('readme.md', '# Ready'));
    if (result.status !== 'ready') throw new Error('Expected a preview');
    const send = (
      fetcher: (
        input: RequestInfo | URL,
        init?: RequestInit
      ) => Promise<Response>
    ) =>
      uploadPublishCover(
        'https://example.test',
        'relic123',
        'submission-token',
        result.preview,
        fetcher
      );
    const refusal = await send(async () =>
      Response.json({ code: 'invalid_cover' }, { status: 400 })
    );
    expect(refusal.status).toBe('refused');
    const unavailable = await send(
      async () => new Response('', { status: 503 })
    );
    expect(unavailable.status).toBe('unconfirmed');
    const lost = await send(async () => {
      throw new Error('connection closed');
    });
    expect(lost.status).toBe('unconfirmed');
    const malformed = await send(
      async () => new Response('not json', { status: 200 })
    );
    expect(malformed.status).toBe('unconfirmed');
    const mismatched = await send(async () =>
      Response.json({
        relic_id: 'relic123',
        version: 1,
        kind: 'markdown',
        type: 'image/png',
        bytes: result.preview.blob.size,
        sha256: '0'.repeat(64),
      })
    );
    expect(mismatched.status).toBe('unconfirmed');
    expect(
      JSON.stringify([refusal, unavailable, lost, malformed, mismatched])
    ).not.toContain('submission-token');
  });

  test('uses the generic card for active and restricted content, even when renamed', async () => {
    const cases = [
      source(
        'plain.txt',
        '<!doctype html><script>fetch("https://third-party.invalid")</script>'
      ),
      source(
        'component.tsx',
        'export default () => <script>doSomething()</script>'
      ),
      source(
        'diagram.txt',
        '<svg><image href="https://third-party.invalid/x" /></svg>'
      ),
      source('notes.txt', '{"nbformat":4,"cells":[],"metadata":{}}'),
      source('timeline.txt', '{"OTIO_SCHEMA":"Timeline.1","tracks":{}}'),
      source('mesh.txt', 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'),
    ];
    for (const [index, entry] of cases.entries()) {
      const before = created.length;
      expect((await generateCoverPreview(entry)).status).toBe('unsupported');
      if (index < 3) expect(created.length).toBe(before);
    }
    expect(created.every((name) => name === 'canvas')).toBe(true);
    expect(lines).toEqual([]);
    expect(networkCalls).toEqual([]);
  });

  test('paints markup inside Markdown as inert text without requesting its remote resource', async () => {
    const result = await generateCoverPreview(
      source(
        'report.md',
        '# Report\n<img src="https://third-party.invalid/image">\n<script>fetch("https://third-party.invalid")</script>'
      )
    );
    expect(result.status).toBe('ready');
    expect(created).toEqual(['canvas']);
    expect(lines).toContain('<img src="https://third-party.invalid/image">');
    expect(lines).toContain(
      '<script>fetch("https://third-party.invalid")</script>'
    );
    expect(networkCalls).toEqual([]);
  });

  test('refuses oversized sources before reading and passes a bound to eligible reads', async () => {
    let reads = 0;
    const tooLarge: CoverPreviewSource = {
      name: 'huge.txt',
      mimetype: 'text/plain',
      size: 32 * 1024 * 1024 + 1,
      async read() {
        reads++;
        throw new Error('Must not read');
      },
    };
    expect((await generateCoverPreview(tooLarge)).status).toBe('unsupported');
    expect(reads).toBe(0);

    const blob = new Blob(['hello']);
    let receivedLimit = -1;
    const bounded: CoverPreviewSource = {
      name: 'small.txt',
      mimetype: 'text/plain',
      size: blob.size,
      async read(maxBytes) {
        receivedLimit = maxBytes;
        return blob;
      },
    };
    expect((await generateCoverPreview(bounded)).status).toBe('ready');
    expect(receivedLimit).toBe(32 * 1024 * 1024);
    const inconsistent: CoverPreviewSource = {
      ...bounded,
      size: blob.size + 1,
    };
    expect((await generateCoverPreview(inconsistent)).status).toBe('failed');
  });
});
