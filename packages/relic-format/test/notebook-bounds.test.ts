import { describe, expect, test } from 'bun:test';
import {
  type NotebookBody,
  type NotebookCell,
  NOTEBOOK_IMAGE_MAX_PIXELS,
  NOTEBOOK_LABEL_MAX_CHARS,
  NOTEBOOK_TEXT_MAX_CHARS,
  parseNotebook,
} from '../src/notebook.ts';

function notebookOf(cells: unknown[]): string {
  return JSON.stringify({
    cells,
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

function codeCell(outputs: unknown[]): unknown {
  return {
    cell_type: 'code',
    metadata: {},
    execution_count: 1,
    source: 'x',
    outputs,
  };
}

function firstCell(text: string): NotebookCell {
  const parsed = parseNotebook(text);
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.kind}`);
  const cell = parsed.notebook.cells[0];
  if (cell === undefined) throw new Error('no cell');
  return cell;
}

function bodiesOf(outputs: unknown[]): NotebookBody[] {
  return firstCell(notebookOf([codeCell(outputs)])).outputs.map(
    (output) => output.body
  );
}

function imageOf(mime: string, data: string): NotebookBody {
  const [body] = bodiesOf([
    { output_type: 'display_data', data: { [mime]: data }, metadata: {} },
  ]);
  if (body === undefined) throw new Error('no body');
  return body;
}

const base64 = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString('base64');

function pngOf(width: number, height: number, type = 'IHDR'): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  for (let i = 0; i < 4; i += 1) bytes[12 + i] = type.charCodeAt(i);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return base64(bytes);
}

function gifOf(width: number, height: number): string {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return base64(bytes);
}

function jpegOf(width: number, height: number): string {
  const bytes = new Uint8Array(20);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  bytes[11] = 3;
  return base64(bytes);
}

/** A WebP whose first chunk is `fourcc`; `fill` writes the chunk's fields. */
function webpOf(
  fourcc: string,
  fill: (view: DataView, bytes: Uint8Array) => void
): string {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  for (let i = 0; i < 4; i += 1) bytes[12 + i] = fourcc.charCodeAt(i);
  fill(new DataView(bytes.buffer), bytes);
  return base64(bytes);
}

describe('notebook text: the cap holds before and after escaping', () => {
  test('a source of raw C1 characters is cut to the cap, not expanded first', () => {
    const source = '\u0080'.repeat(NOTEBOOK_TEXT_MAX_CHARS + 10);
    const cell = firstCell(
      notebookOf([{ cell_type: 'markdown', metadata: {}, source }])
    );
    expect(cell.source.text.length).toBe(NOTEBOOK_TEXT_MAX_CHARS);
    expect(cell.source.truncated).toBe(true);
    expect(cell.source.text.startsWith('[U+0080]')).toBe(true);
  });

  test('an error name is capped, and invisible characters in a value are escaped', () => {
    const ename = `E${'x'.repeat(100_000)}`;
    const [body] = bodiesOf([
      { output_type: 'error', ename, evalue: 'a\u202eb', traceback: [] },
    ]);
    expect(body?.kind).toBe('error');
    if (body?.kind !== 'error') return;
    expect(body.name.length).toBe(NOTEBOOK_LABEL_MAX_CHARS);
    expect(body.value).toBe('a[U+202E]b');
  });

  test('a withheld MIME label is capped', () => {
    const mime = `application/vnd.jupyter.widget-${'w'.repeat(10_000)}`;
    const [body] = bodiesOf([
      { output_type: 'display_data', data: { [mime]: 'x' }, metadata: {} },
    ]);
    expect(body?.kind).toBe('withheld');
    if (body?.kind !== 'withheld') return;
    expect(body.label.length).toBe(NOTEBOOK_LABEL_MAX_CHARS);
  });

  test('the nbformat number a refusal shows is capped', () => {
    const digits = '1'.repeat(10_000);
    const parsed = parseNotebook(`{"cells":[],"nbformat":${digits}}`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok || parsed.refusal.kind !== 'nbformat') return;
    expect(parsed.refusal.found.length).toBe(NOTEBOOK_LABEL_MAX_CHARS);
  });

  test('a markdown character that reorders text is escaped in the display', () => {
    const cell = firstCell(
      notebookOf([{ cell_type: 'markdown', metadata: {}, source: 'a\u061cb' }])
    );
    expect(cell.source.text).toBe('a[U+061C]b');
  });
});

describe('notebook images: pixel size is read from the header', () => {
  test('a PNG declaring a large canvas is refused, and an ordinary one is shown', () => {
    expect(imageOf('image/png', pngOf(60_000, 60_000))).toEqual({
      kind: 'image-refused',
      reason: 'size',
      declared: 'image/png',
    });
    expect(imageOf('image/png', pngOf(100, 100)).kind).toBe('image');
  });

  test('a single image is capped at 50 megapixels', () => {
    expect(imageOf('image/png', pngOf(7071, 7071)).kind).toBe('image');
    expect(imageOf('image/png', pngOf(7072, 7072))).toMatchObject({
      kind: 'image-refused',
      reason: 'size',
    });
    expect(NOTEBOOK_IMAGE_MAX_PIXELS).toBe(50_000_000);
  });

  test('all images together are capped at 200 megapixels', () => {
    const bodies = bodiesOf(
      Array.from({ length: 5 }, () => ({
        output_type: 'display_data',
        data: { 'image/png': pngOf(7000, 7000) },
        metadata: {},
      }))
    );
    expect(bodies.slice(0, 4).map((body) => body.kind)).toEqual([
      'image',
      'image',
      'image',
      'image',
    ]);
    expect(bodies[4]).toMatchObject({ kind: 'image-refused', reason: 'size' });
  });

  test('a malformed PNG header is refused as a bad signature', () => {
    expect(imageOf('image/png', pngOf(10, 10, 'XHDR'))).toMatchObject({
      kind: 'image-refused',
      reason: 'signature',
    });
    expect(imageOf('image/png', pngOf(0, 10))).toMatchObject({
      kind: 'image-refused',
      reason: 'signature',
    });
    expect(
      imageOf(
        'image/png',
        base64(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      )
    ).toMatchObject({ kind: 'image-refused', reason: 'signature' });
  });

  test('a GIF is sized from its logical screen, and a zero side is refused', () => {
    expect(imageOf('image/gif', gifOf(1000, 1000)).kind).toBe('image');
    expect(imageOf('image/gif', gifOf(65_535, 65_535))).toMatchObject({
      kind: 'image-refused',
      reason: 'size',
    });
    expect(imageOf('image/gif', gifOf(0, 1000))).toMatchObject({
      kind: 'image-refused',
      reason: 'signature',
    });
  });

  test('a JPEG is sized from its start-of-frame segment', () => {
    expect(imageOf('image/jpeg', jpegOf(2000, 1000)).kind).toBe('image');
    expect(imageOf('image/jpeg', jpegOf(65_535, 65_535))).toMatchObject({
      kind: 'image-refused',
      reason: 'size',
    });
    const noFrame = base64(
      new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0x00, 0x00])
    );
    expect(imageOf('image/jpeg', noFrame)).toMatchObject({
      kind: 'image-refused',
      reason: 'signature',
    });
  });

  test('a WebP is sized from its VP8X, VP8L or VP8 header, at the 50-megapixel edge', () => {
    const extended = (width: number, height: number) =>
      webpOf('VP8X', (view) => {
        view.setUint16(24, width - 1, true);
        view.setUint16(27, height - 1, true);
      });
    expect(imageOf('image/webp', extended(7000, 7000)).kind).toBe('image');
    expect(imageOf('image/webp', extended(8000, 7000))).toMatchObject({
      kind: 'image-refused',
      reason: 'size',
    });

    const lossless = (width: number, height: number) =>
      webpOf('VP8L', (view) => {
        view.setUint8(20, 0x2f);
        view.setUint32(21, ((width - 1) | ((height - 1) << 14)) >>> 0, true);
      });
    expect(imageOf('image/webp', lossless(7000, 7000)).kind).toBe('image');
    expect(imageOf('image/webp', lossless(8000, 7000))).toMatchObject({
      kind: 'image-refused',
      reason: 'size',
    });

    const lossy = (width: number, height: number) =>
      webpOf('VP8 ', (view, bytes) => {
        bytes.set([0x9d, 0x01, 0x2a], 23);
        view.setUint16(26, width, true);
        view.setUint16(28, height, true);
      });
    expect(imageOf('image/webp', lossy(7000, 7000)).kind).toBe('image');
    expect(imageOf('image/webp', lossy(8000, 7000))).toMatchObject({
      kind: 'image-refused',
      reason: 'size',
    });
  });

  test('a WebP whose first chunk is unknown is refused as a bad signature', () => {
    expect(
      imageOf(
        'image/webp',
        webpOf('ABCD', () => {})
      )
    ).toMatchObject({
      kind: 'image-refused',
      reason: 'signature',
    });
  });
});

describe('notebook text: a large raw source is cut before it is expanded', () => {
  test('32 MB of raw DEL in a markdown cell is shown in under a second', () => {
    // DEL is one byte in UTF-8, so 32 million of them fill the file cap. Escaping
    // them before the cut expanded each to eight characters: about 3.5 s and
    // 4.8 GB of RSS. Cutting first takes about 0.16 s and 300 MB.
    const source = '\u007f'.repeat(32_000_000);
    const started = performance.now();
    const cell = firstCell(
      notebookOf([{ cell_type: 'markdown', metadata: {}, source }])
    );
    expect(performance.now() - started).toBeLessThan(1000);
    expect(cell.source.text.length).toBe(NOTEBOOK_TEXT_MAX_CHARS);
    expect(cell.source.truncated).toBe(true);
  });
});
